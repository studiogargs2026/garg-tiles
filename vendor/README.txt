supabase-js 2.45.4 (MIT), hosted with the app because some mobile networks block the CDN.
jsPDF 2.5.1 (MIT), hosted with the app for making the selection and quotation PDFs.
onnxruntime-web 1.20.1 (MIT, ort/), runs the photo search model on the phone.
model/tile-match-v1.onnx: ConvNeXt-Tiny ImageNet-22k (Apache 2.0, from the ONNX model zoo, timm
weights), cut before its classifier, shrunk to 8-bit and given a fixed 256-number reduction by
tools/photo_vectors.py model.
pdf.js 4.10.38 (Apache 2.0, pdfjs/, legacy build), reads the daily stock PDFs on the phone.
