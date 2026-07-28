import { randomUUID } from 'node:crypto';

import { AsyncEntry } from '@napi-rs/keyring';

const entry = new AsyncEntry(
  `com.lonexplorer.xianyu-order-manager.smoke.${randomUUID()}`,
  'temporary-platform-check',
);
const value = `temporary-${randomUUID()}`;
let stored = false;

try {
  await entry.setPassword(value);
  stored = true;
  if ((await entry.getPassword()) !== value) {
    throw new Error('系统凭据读回结果不一致');
  }
} finally {
  if (stored) await entry.deleteCredential();
}

if (await entry.getPassword()) {
  throw new Error('系统凭据冒烟测试未能清理临时条目');
}

console.log('System credential store smoke test passed and cleaned up.');
