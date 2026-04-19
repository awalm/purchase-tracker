import { PDFDocument } from 'pdf-lib';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_IMAGE_DIMENSION = 2200;
const IMAGE_QUALITY_STEPS = [0.72, 0.6, 0.5, 0.4];

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot < 0 || lastDot === name.length - 1) {
    return '';
  }
  return name.slice(lastDot + 1).toLowerCase();
}

function withFileExtension(name: string, extensionWithDot: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot < 0) {
    return `${name}${extensionWithDot}`;
  }
  return `${name.slice(0, lastDot)}${extensionWithDot}`;
}

function isPdfFile(file: File): boolean {
  return file.type.toLowerCase() === 'application/pdf' || getFileExtension(file.name) === 'pdf';
}

function isImageFile(file: File): boolean {
  const type = file.type.toLowerCase();
  const extension = getFileExtension(file.name);
  return IMAGE_TYPES.has(type) || ['jpg', 'jpeg', 'png', 'webp'].includes(extension);
}

function blobFromCanvas(
  canvas: HTMLCanvasElement,
  mimeType: 'image/jpeg' | 'image/webp',
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Image compression produced an empty file.'));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

async function compressImageFile(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('Image compression is unavailable in this browser.');
  }

  const bitmap = await createImageBitmap(file);
  try {
    const maxSide = Math.max(bitmap.width, bitmap.height);
    const scale = maxSide > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / maxSide : 1;
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Image compression failed to initialize drawing context.');
    }

    // Preserve readability when converting transparent images to JPEG.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    const outputMimeType: 'image/jpeg' | 'image/webp' =
      file.type.toLowerCase() === 'image/webp' ? 'image/webp' : 'image/jpeg';

    let bestBlob: Blob | null = null;
    for (const quality of IMAGE_QUALITY_STEPS) {
      const candidate = await blobFromCanvas(canvas, outputMimeType, quality);
      if (!bestBlob || candidate.size < bestBlob.size) {
        bestBlob = candidate;
      }
    }

    if (!bestBlob) {
      throw new Error('Image compression failed.');
    }

    const extension = outputMimeType === 'image/webp' ? '.webp' : '.jpg';
    return new File([bestBlob], withFileExtension(file.name, extension), {
      type: outputMimeType,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

async function compressPdfFile(file: File): Promise<File> {
  const inputBytes = await file.arrayBuffer();

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(inputBytes, { ignoreEncryption: true });
  } catch {
    throw new Error('Unable to compress this PDF. Please upload an unlocked, valid PDF file.');
  }

  const compressedBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });

  return new File([compressedBytes], withFileExtension(file.name, '.pdf'), {
    type: 'application/pdf',
    lastModified: Date.now(),
  });
}

export async function compressUploadFile(file: File): Promise<File> {
  if (isImageFile(file)) {
    return compressImageFile(file);
  }

  if (isPdfFile(file)) {
    return compressPdfFile(file);
  }

  throw new Error('Unsupported file type. Please upload a PDF, JPG, JPEG, PNG, or WEBP file.');
}
