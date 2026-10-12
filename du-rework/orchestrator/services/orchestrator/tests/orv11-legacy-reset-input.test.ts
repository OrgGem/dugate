import { Readable } from 'node:stream';
import { readMigrationPassword } from '../src/modules/identity/legacy-reset-cli';

describe('ORV11 operator password input', () => {
  it('accepts one UTF-8 line and strips its terminal newline', async () => {
    await expect(readMigrationPassword(Readable.from([Buffer.from('mật khẩu mới\r\n')]))).resolves.toBe('mật khẩu mới');
  });
  it.each(['', 'line1\nline2', 'a'.repeat(1027)])('refuses empty, multiline and oversized input', async (value) => {
    await expect(readMigrationPassword(Readable.from([Buffer.from(value)]))).rejects.toThrow('invalid input');
  });
  it('refuses malformed UTF-8', async () => {
    await expect(readMigrationPassword(Readable.from([Buffer.from([0xff, 0xfe])]))).rejects.toThrow('invalid input');
  });
});
