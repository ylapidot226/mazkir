const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let keyBuffer = null;

function getKey() {
  if (!keyBuffer) {
    keyBuffer = Buffer.from(config.encryption.key, 'hex');
  }
  return keyBuffer;
}

/**
 * Encrypt a string using AES-256-GCM
 * Returns format: iv:authTag:ciphertext (hex-encoded)
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt()
 * Handles plain unencrypted text gracefully (returns as-is)
 */
function decrypt(encryptedString) {
  if (!encryptedString) return encryptedString;
  if (!isEncrypted(encryptedString)) return encryptedString;

  const [ivHex, authTagHex, ciphertext] = encryptedString.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if a value looks like encrypted data (hex:hex:hex format)
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return /^[0-9a-f]+$/.test(parts[0]) && /^[0-9a-f]+$/.test(parts[1]) && /^[0-9a-f]+$/.test(parts[2]);
}

module.exports = { encrypt, decrypt, isEncrypted };
