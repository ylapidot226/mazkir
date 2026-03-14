/**
 * One-time migration script to encrypt existing plaintext data in the database.
 * Safe to run multiple times - skips already-encrypted rows.
 *
 * Usage: node scripts/encrypt-existing-data.js
 */
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { encrypt, isEncrypted } = require('../src/utils/encryption');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function encryptMessages() {
  console.log('Encrypting messages...');
  let encrypted = 0;

  const { data, error } = await supabase
    .from('messages')
    .select('id, content')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch messages:', error);
    return;
  }

  for (const msg of data || []) {
    if (!msg.content || isEncrypted(msg.content)) continue;

    const { error: updateError } = await supabase
      .from('messages')
      .update({ content: encrypt(msg.content) })
      .eq('id', msg.id);

    if (updateError) {
      console.error(`Failed to encrypt message ${msg.id}:`, updateError);
    } else {
      encrypted++;
    }
  }

  console.log(`Messages: ${(data || []).length} total, ${encrypted} encrypted`);
}

async function encryptCalendarConnections() {
  console.log('Encrypting calendar connections...');
  let encrypted = 0;

  const { data, error } = await supabase
    .from('calendar_connections')
    .select('id, credentials');

  if (error) {
    console.error('Failed to fetch calendar connections:', error);
    return;
  }

  for (const conn of data || []) {
    if (!conn.credentials || isEncrypted(conn.credentials)) continue;

    const { error: updateError } = await supabase
      .from('calendar_connections')
      .update({ credentials: encrypt(conn.credentials) })
      .eq('id', conn.id);

    if (updateError) {
      console.error(`Failed to encrypt connection ${conn.id}:`, updateError);
    } else {
      encrypted++;
    }
  }

  console.log(`Calendar connections: ${(data || []).length} total, ${encrypted} encrypted`);
}

(async () => {
  console.log('Starting encryption migration...\n');
  await encryptMessages();
  await encryptCalendarConnections();
  console.log('\nDone!');
})();
