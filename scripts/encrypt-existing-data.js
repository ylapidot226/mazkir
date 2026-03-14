/**
 * One-time migration script to encrypt existing plaintext data in the database.
 * Safe to run multiple times - skips already-encrypted rows.
 *
 * Usage: node scripts/encrypt-existing-data.js
 */
require('dotenv').config();

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const keyBuffer = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return /^[0-9a-f]+$/.test(parts[0]) && /^[0-9a-f]+$/.test(parts[1]) && /^[0-9a-f]+$/.test(parts[2]);
}

async function encryptMessages() {
  console.log('Encrypting messages...');
  let encrypted = 0;

  const { data, error } = await supabase
    .from('messages')
    .select('id, content')
    .order('created_at', { ascending: true });

  if (error) { console.error('Failed to fetch messages:', error); return; }

  for (const msg of data || []) {
    if (!msg.content || isEncrypted(msg.content)) continue;
    const { error: e } = await supabase.from('messages').update({ content: encrypt(msg.content) }).eq('id', msg.id);
    if (e) console.error(`Failed ${msg.id}:`, e);
    else encrypted++;
  }

  console.log(`Messages: ${(data || []).length} total, ${encrypted} encrypted`);
}

async function encryptCalendarConnections() {
  console.log('Encrypting calendar connections...');
  let encrypted = 0;

  const { data, error } = await supabase
    .from('calendar_connections')
    .select('id, credentials');

  if (error) { console.error('Failed to fetch:', error); return; }

  for (const conn of data || []) {
    if (!conn.credentials || isEncrypted(conn.credentials)) continue;
    const { error: e } = await supabase.from('calendar_connections').update({ credentials: encrypt(conn.credentials) }).eq('id', conn.id);
    if (e) console.error(`Failed ${conn.id}:`, e);
    else encrypted++;
  }

  console.log(`Calendar connections: ${(data || []).length} total, ${encrypted} encrypted`);
}

(async () => {
  console.log('Starting encryption migration...\n');
  await encryptMessages();
  await encryptCalendarConnections();
  console.log('\nDone!');
})();
