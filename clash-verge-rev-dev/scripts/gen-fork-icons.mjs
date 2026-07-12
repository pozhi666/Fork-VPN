import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const src = 'D:/export.png'
const outDir = path.join(root, 'src-tauri/icons')
const brandDir = path.join(root, 'src/assets/image')

const sizes = {
  'icon.png': 512,
  '32x32.png': 32,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  'Square30x30Logo.png': 30,
  'Square44x44Logo.png': 44,
  'Square71x71Logo.png': 71,
  'Square89x89Logo.png': 89,
  'Square107x107Logo.png': 107,
  'Square142x142Logo.png': 142,
  'Square150x150Logo.png': 150,
  'Square284x284Logo.png': 284,
  'Square310x310Logo.png': 310,
  'StoreLogo.png': 50,
}

const meta = await sharp(src).metadata()
console.log('source', meta.width, meta.height, meta.format)

for (const [name, size] of Object.entries(sizes)) {
  await sharp(src)
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .png()
    .toFile(path.join(outDir, name))
  console.log('wrote', name, size)
}

await sharp(src).resize(256, 256).png().toFile(path.join(brandDir, 'logo.png'))
await sharp(src).resize(512, 512).png().toFile(path.join(outDir, 'fork-source.png'))
// frontend favicon / web
await sharp(src)
  .resize(64, 64)
  .png()
  .toFile(path.join(brandDir, 'logo.ico').replace(/\.ico$/, '-64.png'))

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const pngBuffers = []
for (const s of icoSizes) {
  pngBuffers.push(await sharp(src).resize(s, s).png().toBuffer())
}

const pngToIco = (await import('png-to-ico')).default
const ico = await pngToIco(pngBuffers)
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
const trayIco = await pngToIco([pngBuffers[0], pngBuffers[2], pngBuffers[3]])
fs.writeFileSync(path.join(outDir, 'tray-icon.ico'), trayIco)
for (const name of [
  'tray-icon-mono.ico',
  'tray-icon-sys.ico',
  'tray-icon-sys-mono.ico',
  'tray-icon-sys-mono-new.ico',
  'tray-icon-tun.ico',
  'tray-icon-tun-mono.ico',
  'tray-icon-tun-mono-new.ico',
]) {
  fs.copyFileSync(path.join(outDir, 'tray-icon.ico'), path.join(outDir, name))
}

// simple icns placeholder: macOS needs special format; keep existing or copy png
// Windows-focused for now

console.log('done ->', outDir)
