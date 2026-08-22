import * as crypto from 'node:crypto';

/** AES-256-GCM 算法标识 */
const ALGORITHM = 'aes-256-gcm';
/** IV 长度（字节） */
const IV_LENGTH = 12;
/** Auth Tag 长度（字节） */
const AUTH_TAG_LENGTH = 16;
/** 密钥长度（字节） */
const KEY_LENGTH = 32;

/**
 * 从环境变量读取 ACCOUNT_SECRET_KEY 并返回 32 字节 Buffer
 * 未配置时立即抛出异常（fail-fast：不设默认密钥兜底）
 */
function getKeyBytes(): Buffer {
  const raw = process.env.ACCOUNT_SECRET_KEY;
  if (!raw) {
    throw new Error(
      'ACCOUNT_SECRET_KEY 未配置，无法加解密账号密码。' +
        '请设置环境变量 ACCOUNT_SECRET_KEY（32 字节 hex 或 base64），' +
        '生成方式: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  // 尝试 hex 解码
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // 尝试 base64 解码
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === KEY_LENGTH) {
    return buf;
  }

  throw new Error(
    `ACCOUNT_SECRET_KEY 格式无效：期望 32 字节（hex 64 字符或 base64），实际 ${buf.length} 字节`,
  );
}

/**
 * 加密明文密码
 * @param plain 明文
 * @returns base64 编码的密文，格式: iv(12B) + ciphertext + authTag(16B)，整体 base64
 */
export function encryptSecret(plain: string): string {
  const key = getKeyBytes();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // iv + ciphertext + authTag 拼接后整体 base64
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * 解密密文密码
 * @param cipherText base64 编码的密文
 * @returns 明文
 */
export function decryptSecret(cipherText: string): string {
  const key = getKeyBytes();
  const data = Buffer.from(cipherText, 'base64');

  if (data.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('密文长度不足，无法解密');
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * 启动自检：做一次真实加解密往返，验证密钥配置正确
 * 失败时抛出异常，应用启动终止
 */
export function validateCryptoOrThrow(): void {
  // 先确认密钥存在
  getKeyBytes();

  const testPlain = 'self-test-' + crypto.randomBytes(4).toString('hex');
  const cipher = encryptSecret(testPlain);
  const decrypted = decryptSecret(cipher);

  if (decrypted !== testPlain) {
    throw new Error(
      'ACCOUNT_SECRET_KEY 自检失败：加解密往返结果不一致，请检查密钥格式是否正确',
    );
  }
}