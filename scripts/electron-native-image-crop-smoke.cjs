const assert = require('node:assert/strict');
const { app, nativeImage } = require('electron');

void app.whenReady().then(() => {
  const topPixel = [0, 0, 255, 255];
  const bottomPixel = [255, 0, 0, 255];
  const source = nativeImage.createFromBitmap(
    Buffer.from([...topPixel, ...bottomPixel]),
    { width: 1, height: 2, scaleFactor: 1 },
  );
  assert.deepEqual(source.getSize(), { width: 1, height: 2 });

  const decoded = nativeImage.createFromBuffer(source.toPNG());
  assert.equal(decoded.isEmpty(), false);
  assert.deepEqual(decoded.getSize(), { width: 1, height: 2 });

  const cropped = decoded.crop({ x: 0, y: 0, width: 1, height: 1 });
  assert.equal(cropped.isEmpty(), false);
  assert.deepEqual(cropped.getSize(), { width: 1, height: 1 });
  assert.deepEqual([...cropped.toBitmap().subarray(0, 4)], topPixel);
  assert.notDeepEqual([...cropped.toBitmap().subarray(0, 4)], bottomPixel);

  process.stdout.write('Electron nativeImage crop smoke passed\n');
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
