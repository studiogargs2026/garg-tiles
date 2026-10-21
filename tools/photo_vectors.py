#!/usr/bin/env python3
"""Fingerprints for photo search.

The app recognises tiles in photos with a free picture model (ConvNeXt-Tiny trained on
ImageNet-22k, from the ONNX model zoo on GitHub). The phone runs the model on the photo; this
script runs the very same model file on every catalog picture beforehand.

  photo_vectors.py model THUMBS OUT.onnx
      Downloads the model, keeps only the part that describes a picture, adds a fixed
      reduction to 256 numbers (fitted on the catalog pictures in THUMBS) and shrinks it to
      about 30 MB. Done once; the result goes in the app as vendor/model/tile-match-v1.onnx.
  photo_vectors.py vectors MODEL.onnx THUMBS OUT_DIR
      Fingerprints every picture in THUMBS (320px webp named as in the bucket's thumb/ folder),
      six parts per picture (whole, middle, four corners) so a close-up of part of a tile still
      matches. Writes OUT_DIR/vectors.bin (int8) and OUT_DIR/meta.json. Which tiles are
      highlighters the app asks the database (highlighter_thumbs), so that stays current.
  Then upload both files to photo/ in the bucket:
      GARG_UPLOAD_TOKEN=... photo_vectors.py send OUT_DIR
"""
import json, os, sys, tempfile, time, urllib.request
import numpy as np
from PIL import Image

ZOO = ('https://media.githubusercontent.com/media/onnx/models/main/Computer_Vision/'
       'convnext_tiny_in22k_Opset16_timm/convnext_tiny_in22k_Opset16.onnx')
FEATURES = '/head/flatten/Flatten_output_0'     # 768 numbers, just before the classifier
DIM = 256
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
# whole picture, middle, and the four corners (x0, y0, x1, y1); photo.js scores a tile by its best part
PARTS = [(0, 0, 1, 1), (.2, .2, .8, .8), (0, 0, .55, .55), (.45, 0, 1, .55), (0, .45, .55, 1), (.45, .45, 1, 1)]
SUPABASE = 'https://sdsvuhwfzqkmiktysqsy.supabase.co'


def prep(im):
    a = (np.asarray(im.convert('RGB').resize((224, 224), Image.BILINEAR), np.float32) / 255 - MEAN) / STD
    return a.transpose(2, 0, 1)[None]


def parts(im):
    im = im.convert('RGB')
    w, h = im.size
    return [im.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h))) for x0, y0, x1, y1 in PARTS]


def thumbs(folder):
    return sorted(f for f in os.listdir(folder) if f.endswith('.webp'))


def session(path):
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = os.cpu_count()
    return ort.InferenceSession(path, so)


def progress(i, n, start, every):
    if i % every == 0 or i == n:
        left = (time.time() - start) / max(i, 1) * (n - i)
        print(f'{i}/{n} ({i * 100 // n}%), about {left / 60:.0f} min left', flush=True)


def make_model(folder, out):
    import onnx
    from onnx import helper, numpy_helper
    from onnx.utils import extract_model
    from onnxruntime.quantization import quantize_dynamic, QuantType
    tmp = tempfile.mkdtemp()
    zoo, feat, quant = (os.path.join(tmp, n) for n in ('zoo.onnx', 'feat.onnx', 'quant.onnx'))
    print('downloading the model', flush=True)
    urllib.request.urlretrieve(ZOO, zoo)
    extract_model(zoo, feat, ['x'], [FEATURES])
    # MatMul only: every phone browser runs these
    quantize_dynamic(feat, quant, op_types_to_quantize=['MatMul', 'Gemm'], weight_type=QuantType.QInt8)

    # fit the 768 -> 256 reduction on a sample of catalog picture parts
    s = session(quant)
    files = thumbs(folder)
    rng = np.random.default_rng(0)
    sample = rng.choice(len(files), min(1500, len(files)), replace=False)
    feats, start = [], time.time()
    for i, k in enumerate(sample, 1):
        for p in parts(Image.open(os.path.join(folder, files[k]))):
            v = s.run(None, {'x': prep(p)})[0][0]
            feats.append(v / np.linalg.norm(v))
        progress(i, len(sample), start, 150)
    X = np.array(feats)
    mu = X.mean(0)
    _, _, vt = np.linalg.svd(X - mu, full_matrices=False)
    W = vt[:DIM].T.astype(np.float32)        # 768 x 256

    m = onnx.load(quant)
    out_name = m.graph.output[0].name
    m.graph.initializer.extend([numpy_helper.from_array(mu.astype(np.float32), 'pca_mean'),
                                numpy_helper.from_array(W, 'pca_w')])
    # normalise first (the reduction was fitted on normalised fingerprints), then reduce
    m.graph.node.extend([
        helper.make_node('ReduceL2', [out_name], ['fp_norm'], axes=[1], keepdims=1),
        helper.make_node('Div', [out_name, 'fp_norm'], ['fp_unit']),
        helper.make_node('Sub', ['fp_unit', 'pca_mean'], ['fp_centred']),
        helper.make_node('MatMul', ['fp_centred', 'pca_w'], ['fingerprint']),
    ])
    del m.graph.output[:]
    m.graph.output.extend([helper.make_tensor_value_info('fingerprint', onnx.TensorProto.FLOAT, [1, DIM])])
    onnx.checker.check_model(m)
    onnx.save(m, out)
    print(f'saved {out} ({os.path.getsize(out) / 1e6:.0f} MB)')


def make_vectors(model, folder, out_dir):
    s = session(model)
    files = thumbs(folder)
    os.makedirs(out_dir, exist_ok=True)
    vecs, start = [], time.time()
    for i, f in enumerate(files, 1):
        im = Image.open(os.path.join(folder, f))
        for p in parts(im):
            v = s.run(None, {'x': prep(p)})[0][0]
            vecs.append(v / np.linalg.norm(v))
        progress(i, len(files), start, max(1, len(files) // 20))
    V = np.array(vecs, np.float32)
    q = np.round(V / np.abs(V).max(1, keepdims=True) * 127).astype(np.int8)   # each row scaled on its own
    q.tofile(os.path.join(out_dir, 'vectors.bin'))
    paths = ['thumb/' + f for f in files]
    meta = {
        'model': 'tile-match-v1', 'dim': int(V.shape[1]), 'per': len(PARTS), 'paths': paths,
        'made': time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()),
    }
    json.dump(meta, open(os.path.join(out_dir, 'meta.json'), 'w'), separators=(',', ':'))
    print(f'{len(files)} pictures -> {out_dir}')


def send(out_dir):
    token = os.environ['GARG_UPLOAD_TOKEN']
    for name, kind in (('vectors.bin', 'application/octet-stream'), ('meta.json', 'application/json')):
        data = open(os.path.join(out_dir, name), 'rb').read()
        req = urllib.request.Request(f'{SUPABASE}/functions/v1/admin-upload?op=file&path=photo/{name}', data=data,
                                     method='POST', headers={'x-upload-token': token, 'content-type': kind})
        print(name, urllib.request.urlopen(req).read().decode()[:200])


if __name__ == '__main__':
    cmd, *args = sys.argv[1:]
    {'model': make_model, 'vectors': make_vectors, 'send': send}[cmd](*args)
