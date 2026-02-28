interface CropArea {
  x: number
  y: number
  width: number
  height: number
}

const MAX_OUTPUT_DIM = 3840
const MAX_OUTPUT_DIM_SHORT = 2160

export async function getCroppedImageBlob(
  imageSrc: string,
  cropArea: CropArea,
  rotation: number = 0,
  brightness: number = 100,
  contrast: number = 100,
  outputRotation: number = 0
): Promise<Blob> {
  const image = await loadImage(imageSrc)
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")!

  const rotRad = (rotation * Math.PI) / 180

  const { width: bBoxWidth, height: bBoxHeight } = getRotatedBoundingBox(
    image.width,
    image.height,
    rotation
  )

  canvas.width = bBoxWidth
  canvas.height = bBoxHeight

  ctx.translate(bBoxWidth / 2, bBoxHeight / 2)
  ctx.rotate(rotRad)
  ctx.translate(-image.width / 2, -image.height / 2)
  ctx.drawImage(image, 0, 0)

  let outWidth = cropArea.width
  let outHeight = cropArea.height

  const maxW = outWidth >= outHeight ? MAX_OUTPUT_DIM : MAX_OUTPUT_DIM_SHORT
  const maxH = outHeight >= outWidth ? MAX_OUTPUT_DIM : MAX_OUTPUT_DIM_SHORT
  if (outWidth > maxW || outHeight > maxH) {
    const scale = Math.min(maxW / outWidth, maxH / outHeight)
    outWidth = Math.round(outWidth * scale)
    outHeight = Math.round(outHeight * scale)
  }

  const croppedCanvas = document.createElement("canvas")
  const croppedCtx = croppedCanvas.getContext("2d")!

  croppedCanvas.width = outWidth
  croppedCanvas.height = outHeight

  const hasFilter = brightness !== 100 || contrast !== 100
  if (hasFilter) {
    croppedCtx.filter = `brightness(${brightness}%) contrast(${contrast}%)`
  }

  croppedCtx.drawImage(
    canvas,
    cropArea.x,
    cropArea.y,
    cropArea.width,
    cropArea.height,
    0,
    0,
    outWidth,
    outHeight
  )

  let finalCanvas = croppedCanvas
  if (outputRotation && outputRotation % 360 !== 0) {
    const rotRad = (outputRotation * Math.PI) / 180
    const { width: rW, height: rH } = getRotatedBoundingBox(outWidth, outHeight, outputRotation)
    const rotatedCanvas = document.createElement("canvas")
    rotatedCanvas.width = Math.round(rW)
    rotatedCanvas.height = Math.round(rH)
    const rCtx = rotatedCanvas.getContext("2d")!
    rCtx.translate(rotatedCanvas.width / 2, rotatedCanvas.height / 2)
    rCtx.rotate(rotRad)
    rCtx.translate(-outWidth / 2, -outHeight / 2)
    rCtx.drawImage(croppedCanvas, 0, 0)
    finalCanvas = rotatedCanvas
  }

  return new Promise((resolve, reject) => {
    finalCanvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("Canvas toBlob failed"))
        resolve(blob)
      },
      "image/jpeg",
      0.85
    )
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function getRotatedBoundingBox(width: number, height: number, rotation: number) {
  const rotRad = (rotation * Math.PI) / 180
  return {
    width:
      Math.abs(Math.cos(rotRad) * width) + Math.abs(Math.sin(rotRad) * height),
    height:
      Math.abs(Math.sin(rotRad) * width) + Math.abs(Math.cos(rotRad) * height),
  }
}
