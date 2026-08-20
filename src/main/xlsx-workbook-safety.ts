import yauzl from 'yauzl';

const MAX_ARCHIVE_ENTRIES = 500;
const MAX_ARCHIVE_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

export function assertXlsxWorkbookArchiveLimits(
  buffer: Buffer,
  subject: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(new Error(`无法读取${subject}，请确认文件是有效的 .xlsx 文件`));
        return;
      }
      let entryCount = 0;
      let totalBytes = 0;
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(new Error(message));
      };
      zipFile.on('error', () => (
        fail(`无法读取${subject}，请确认文件是有效的 .xlsx 文件`)
      ));
      zipFile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zipFile.on('entry', (entry) => {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) {
          fail(`${subject}内部文件数量过多`);
          return;
        }
        if (entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) {
          fail(`${subject}解压后内容过大`);
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zipFile.readEntry();
          return;
        }
        let entryBytes = 0;
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(`无法读取${subject}，请确认文件是有效的 .xlsx 文件`);
            return;
          }
          stream.on('error', () => (
            fail(`无法读取${subject}，请确认文件是有效的 .xlsx 文件`)
          ));
          stream.on('data', (chunk: Buffer) => {
            entryBytes += chunk.length;
            totalBytes += chunk.length;
            if (
              entryBytes > MAX_ARCHIVE_ENTRY_BYTES ||
              totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES
            ) {
              fail(`${subject}解压后内容过大`);
              stream.destroy();
            }
          });
          stream.on('end', () => {
            if (!settled) zipFile.readEntry();
          });
        });
      });
      zipFile.readEntry();
    });
  });
}
