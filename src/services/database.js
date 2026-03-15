const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/encryption');

const supabase = createClient(config.supabase.url, config.supabase.key);

// ---- Users ----

async function getUser(phoneNumber) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone_number', phoneNumber)
    .single();

  if (error && error.code !== 'PGRST116') {
    logger.error('database', 'Failed to get user', error);
  }
  return data;
}

async function createUser(phoneNumber, name, email) {
  const insertData = { phone_number: phoneNumber, name: name || null };
  if (email) insertData.email = email;
  const { data, error } = await supabase
    .from('users')
    .insert(insertData)
    .select()
    .single();

  if (error) {
    logger.error('database', 'Failed to create user', error);
    throw error;
  }
  logger.info('database', 'User created', { phoneNumber });
  return data;
}

async function activateUser(userId) {
  const { error } = await supabase
    .from('users')
    .update({ status: 'active' })
    .eq('id', userId);

  if (error) {
    logger.error('database', 'Failed to activate user', error);
    throw error;
  }
  logger.info('database', 'User activated', { userId });
}

async function blockUser(userId) {
  const { error } = await supabase
    .from('users')
    .update({ status: 'blocked' })
    .eq('id', userId);

  if (error) {
    logger.error('database', 'Failed to block user', error);
    throw error;
  }
}

async function deleteUser(userId) {
  const { error } = await supabase
    .from('users')
    .delete()
    .eq('id', userId);

  if (error) {
    logger.error('database', 'Failed to delete user', error);
    throw error;
  }
  logger.info('database', 'User deleted', { userId });
}

async function updateUserPhone(userId, newPhoneNumber) {
  const { error } = await supabase
    .from('users')
    .update({ phone_number: newPhoneNumber })
    .eq('id', userId);

  if (error) {
    logger.error('database', 'Failed to update user phone', error);
    throw error;
  }
  logger.info('database', 'User phone updated', { userId, newPhoneNumber });
}

async function getPendingUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('database', 'Failed to get pending users', error);
    throw error;
  }
  return data || [];
}

async function getAllUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('database', 'Failed to get all users', error);
    throw error;
  }
  return data || [];
}

// ---- Events ----

async function addEvent(userId, title, datetime, location) {
  // Check for duplicate event (same user, title, datetime)
  const { data: existing } = await supabase
    .from('events')
    .select('id')
    .eq('user_id', userId)
    .eq('title', title)
    .eq('datetime', datetime)
    .limit(1);

  if (existing && existing.length > 0) {
    logger.info('database', 'Duplicate event skipped', { userId, title, datetime });
    return existing[0];
  }

  const { data, error } = await supabase
    .from('events')
    .insert({ user_id: userId, title, datetime, location })
    .select()
    .single();

  if (error) {
    logger.error('database', 'Failed to add event', error);
    throw error;
  }
  logger.info('database', 'Event added', { userId, title, datetime });
  return data;
}

async function getUpcomingEvents(userId, daysAhead = null, startDaysAhead = 0) {
  // Include events from start of today (Israel time), not just from "now"
  const startDate = new Date(getStartOfToday().getTime() + startDaysAhead * 24 * 60 * 60 * 1000);
  const startDateISO = startDate.toISOString();

  let query = supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .gte('datetime', startDateISO);

  // If daysAhead specified, limit the range (0 = today only, 7 = this week, etc.)
  if (daysAhead !== null) {
    const endDate = new Date(getStartOfToday().getTime() + (daysAhead + 1) * 24 * 60 * 60 * 1000);
    query = query.lt('datetime', endDate.toISOString());
  }

  query = query.order('datetime', { ascending: true }).limit(20);

  const { data, error } = await query;

  if (error) {
    logger.error('database', 'Failed to get events', error);
    throw error;
  }
  return data || [];
}

/**
 * Get upcoming events by explicit date range (ISO strings)
 */
async function getUpcomingEventsByDateRange(userId, startDate = null, endDate = null) {
  const startISO = startDate || getStartOfToday().toISOString();

  let query = supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .gte('datetime', startISO);

  if (endDate) {
    query = query.lte('datetime', endDate);
  }

  query = query.order('datetime', { ascending: true }).limit(20);

  const { data, error } = await query;

  if (error) {
    logger.error('database', 'Failed to get events by date range', error);
    throw error;
  }
  return data || [];
}

/**
 * Get start of today in a given timezone as a UTC Date object
 */
function getStartOfToday(timezone = 'Asia/Jerusalem') {
  // Get timezone offset by comparing UTC and timezone formatted times
  const now = new Date();
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
  const tzStr = now.toLocaleString('en-US', { timeZone: timezone, hour12: false });
  const offsetMs = new Date(tzStr) - new Date(utcStr);

  // Shift now by timezone offset to get local time, then zero out hours
  const localNow = new Date(now.getTime() + offsetMs);
  localNow.setUTCHours(0, 0, 0, 0);

  // Shift back to UTC
  return new Date(localNow.getTime() - offsetMs);
}

async function getUserTimezone(userId) {
  const { data } = await supabase.from('users').select('timezone').eq('id', userId).single();
  return data?.timezone || 'Asia/Jerusalem';
}

async function getEventsMatchingContent(userId, content) {
  const { data } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .ilike('title', `%${content}%`);
  return data || [];
}

async function deleteEventByContent(userId, content) {
  const { data } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .ilike('title', `%${content}%`)
    .order('datetime', { ascending: true });

  if (data && data.length > 0) {
    // Only delete the closest upcoming event, not all matches
    const event = data[0];
    await supabase.from('events').delete().eq('id', event.id);
    logger.info('database', 'Event deleted', { userId, eventId: event.id, title: event.title });
    return event; // Return the actual deleted event for calendar sync
  }
  return null;
}

async function deleteAllEvents(userId) {
  const { data } = await supabase
    .from('events')
    .select('id')
    .eq('user_id', userId)
    .gte('datetime', getStartOfToday().toISOString());

  if (data && data.length > 0) {
    for (const event of data) {
      await supabase.from('events').delete().eq('id', event.id);
    }
    logger.info('database', 'All events deleted', { userId, count: data.length });
    return data.length;
  }
  return 0;
}

async function deleteTaskByContent(userId, content) {
  const { data } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('completed', false)
    .ilike('content', `%${content}%`);

  if (data && data.length > 0) {
    await supabase.from('tasks').delete().eq('id', data[0].id);
    logger.info('database', 'Task deleted', { userId, content });
    return data[0];
  }
  return null;
}

/**
 * Get all today's events for all active users (for daily 6am summary)
 */
async function getTodayEventsAllUsers() {
  const startOfToday = getStartOfToday();
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('events')
    .select('*, users(phone_number, status)')
    .gte('datetime', startOfToday.toISOString())
    .lt('datetime', endOfToday.toISOString())
    .order('datetime', { ascending: true });

  if (error) {
    logger.error('database', 'Failed to get today events for all users', error);
    return [];
  }

  // Filter only active users
  return (data || []).filter((e) => e.users?.status === 'active');
}

/**
 * Get all tomorrow's events for all active users (for 9pm evening summary)
 */
async function getTomorrowEventsAllUsers() {
  const startOfToday = getStartOfToday();
  const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const endOfTomorrow = new Date(startOfTomorrow.getTime() + 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('events')
    .select('*, users(phone_number, status)')
    .gte('datetime', startOfTomorrow.toISOString())
    .lt('datetime', endOfTomorrow.toISOString())
    .order('datetime', { ascending: true });

  if (error) {
    logger.error('database', 'Failed to get tomorrow events for all users', error);
    return [];
  }

  return (data || []).filter((e) => e.users?.status === 'active');
}

/**
 * Get events happening in ~1 hour that haven't been reminded yet
 */
async function getEventsForHourlyReminder() {
  const now = new Date();
  const in55min = new Date(now.getTime() + 55 * 60 * 1000);
  const in65min = new Date(now.getTime() + 65 * 60 * 1000);

  const { data, error } = await supabase
    .from('events')
    .select('*, users(phone_number, status)')
    .eq('reminder_sent', false)
    .gte('datetime', in55min.toISOString())
    .lte('datetime', in65min.toISOString());

  if (error) {
    logger.error('database', 'Failed to get hourly reminders', error);
    return [];
  }

  return (data || []).filter((e) => e.users?.status === 'active');
}

/**
 * @deprecated Use getTodayEventsAllUsers and getEventsForHourlyReminder instead
 */
async function getEventsForReminder() {
  return { dayBefore: [], dayOf: [] };
}

async function markReminderSent(eventId, field = 'reminder_sent') {
  const { error } = await supabase
    .from('events')
    .update({ [field]: true })
    .eq('id', eventId);

  if (error) logger.error('database', 'Failed to mark reminder sent', error);
}

// ---- Tasks ----

async function addTask(userId, category, content) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({ user_id: userId, category, content })
    .select()
    .single();

  if (error) {
    logger.error('database', 'Failed to add task', error);
    throw error;
  }
  logger.info('database', 'Task added', { userId, category, content });
  return data;
}

async function getTasks(userId, category = null) {
  let query = supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('completed', false)
    .order('created_at', { ascending: true });

  if (category) {
    query = query.eq('category', category);
  }

  const { data, error } = await query;
  if (error) {
    logger.error('database', 'Failed to get tasks', error);
    throw error;
  }
  return data || [];
}

async function getCategories(userId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('category')
    .eq('user_id', userId)
    .eq('completed', false);

  if (error) {
    logger.error('database', 'Failed to get categories', error);
    throw error;
  }
  const unique = [...new Set((data || []).map((t) => t.category))];
  return unique;
}

async function getCategoriesWithCounts(userId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('category')
    .eq('user_id', userId)
    .eq('completed', false);

  if (error) {
    logger.error('database', 'Failed to get categories with counts', error);
    throw error;
  }
  const counts = {};
  for (const t of data || []) {
    counts[t.category] = (counts[t.category] || 0) + 1;
  }
  return counts;
}

async function deleteTasksByCategory(userId, category) {
  const { data, error } = await supabase
    .from('tasks')
    .delete()
    .eq('user_id', userId)
    .eq('category', category)
    .select();

  if (error) {
    logger.error('database', 'Failed to delete list', error);
    throw error;
  }
  logger.info('database', 'List deleted', { userId, category, count: (data || []).length });
  return (data || []).length;
}

async function completeTask(userId, taskId) {
  const { error } = await supabase
    .from('tasks')
    .update({ completed: true })
    .eq('id', taskId)
    .eq('user_id', userId);

  if (error) {
    logger.error('database', 'Failed to complete task', error);
    throw error;
  }
}

async function completeTaskByContent(userId, category, content) {
  // Find matching task by partial content match
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('completed', false)
    .ilike('content', `%${content}%`);

  if (error) {
    logger.error('database', 'Failed to find task', error);
    throw error;
  }

  if (data && data.length > 0) {
    await completeTask(userId, data[0].id);
    return data[0];
  }
  return null;
}

// ---- Shopping List ----

async function addShoppingItem(userId, item) {
  const { data, error } = await supabase
    .from('shopping_list')
    .insert({ user_id: userId, item })
    .select()
    .single();

  if (error) {
    logger.error('database', 'Failed to add shopping item', error);
    throw error;
  }
  logger.info('database', 'Shopping item added', { userId, item });
  return data;
}

async function getShoppingList(userId) {
  const { data, error } = await supabase
    .from('shopping_list')
    .select('*')
    .eq('user_id', userId)
    .eq('done', false)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('database', 'Failed to get shopping list', error);
    throw error;
  }
  return data || [];
}

async function markShoppingDone(userId, item) {
  const { data, error } = await supabase
    .from('shopping_list')
    .select('*')
    .eq('user_id', userId)
    .eq('done', false)
    .ilike('item', `%${item}%`);

  if (error) {
    logger.error('database', 'Failed to find shopping item', error);
    throw error;
  }

  if (data && data.length > 0) {
    await supabase.from('shopping_list').update({ done: true }).eq('id', data[0].id);
    return data[0];
  }
  return null;
}

async function markShoppingDoneById(userId, itemId) {
  const { error } = await supabase
    .from('shopping_list')
    .update({ done: true })
    .eq('id', itemId)
    .eq('user_id', userId);

  if (error) {
    logger.error('database', 'Failed to mark shopping done by ID', error);
  }
}

async function clearShoppingList(userId) {
  const { error } = await supabase
    .from('shopping_list')
    .update({ done: true })
    .eq('user_id', userId)
    .eq('done', false);

  if (error) {
    logger.error('database', 'Failed to clear shopping list', error);
    throw error;
  }
}

// ---- Reminders ----

async function addReminder(userId, content, remindAt) {
  const { data, error } = await supabase
    .from('reminders')
    .insert({ user_id: userId, content, remind_at: remindAt })
    .select()
    .single();

  if (error) {
    logger.error('database', 'Failed to add reminder', error);
    throw error;
  }
  logger.info('database', 'Reminder added', { userId, content, remindAt });
  return data;
}

async function getDueReminders() {
  const now = new Date();
  const in1min = new Date(now.getTime() + 60 * 1000);

  const { data, error } = await supabase
    .from('reminders')
    .select('*, users(phone_number, status)')
    .eq('sent', false)
    .lte('remind_at', in1min.toISOString());

  if (error) {
    logger.error('database', 'Failed to get due reminders', error);
    return [];
  }
  return (data || []).filter((r) => r.users?.status === 'active');
}

async function markReminderDone(reminderId) {
  const { error } = await supabase
    .from('reminders')
    .update({ sent: true })
    .eq('id', reminderId);

  if (error) logger.error('database', 'Failed to mark reminder done', error);
}

// ---- Recurring Events ----

async function addRecurringEvent(userId, title, days, time, location) {
  const { data, error } = await supabase
    .from('recurring_events')
    .insert({ user_id: userId, title, days, time, location })
    .select()
    .single();

  if (error) {
    logger.error('database', 'Failed to add recurring event', error);
    throw error;
  }
  logger.info('database', 'Recurring event added', { userId, title, days, time });
  return data;
}

async function getActiveRecurringEvents() {
  const { data, error } = await supabase
    .from('recurring_events')
    .select('*, users(phone_number, status)')
    .eq('active', true);

  if (error) {
    logger.error('database', 'Failed to get recurring events', error);
    return [];
  }
  return (data || []).filter((e) => e.users?.status === 'active');
}

async function getUserRecurringEvents(userId) {
  const { data, error } = await supabase
    .from('recurring_events')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('database', 'Failed to get user recurring events', error);
    return [];
  }
  return data || [];
}

async function deleteRecurringEventByContent(userId, content) {
  const { data } = await supabase
    .from('recurring_events')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true)
    .ilike('title', `%${content}%`);

  if (data && data.length > 0) {
    await supabase
      .from('recurring_events')
      .update({ active: false })
      .eq('id', data[0].id);
    logger.info('database', 'Recurring event deactivated', { userId, title: data[0].title });
    return data[0];
  }
  return null;
}

/**
 * Check if an event from a recurring pattern already exists today
 */
async function recurringEventExistsToday(userId, title, datetime) {
  const startOfToday = getStartOfToday();
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

  const { data } = await supabase
    .from('events')
    .select('id')
    .eq('user_id', userId)
    .eq('title', title)
    .gte('datetime', startOfToday.toISOString())
    .lt('datetime', endOfToday.toISOString())
    .limit(1);

  return data && data.length > 0;
}

// ---- Poll Mappings (stored in Supabase for serverless) ----

async function savePollMapping(userId, pollMessageId, tasks) {
  // Clean up old mappings (older than 24h)
  await supabase
    .from('poll_mappings')
    .delete()
    .lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const { error } = await supabase
    .from('poll_mappings')
    .insert({
      user_id: userId,
      poll_message_id: pollMessageId,
      tasks: JSON.stringify(tasks.map((t) => ({ id: t.id, content: t.content, type: t.type, external_id: t.external_id, source: t.source }))),
    });

  if (error) {
    logger.error('database', 'Failed to save poll mapping', error);
  }
}

async function getPollMapping(userId, pollMessageId) {
  const { data, error } = await supabase
    .from('poll_mappings')
    .select('*')
    .eq('user_id', userId)
    .eq('poll_message_id', pollMessageId)
    .single();

  if (error && error.code !== 'PGRST116') {
    logger.error('database', 'Failed to get poll mapping', error);
  }
  if (data) {
    return { tasks: JSON.parse(data.tasks) };
  }
  return null;
}

// ---- Messages (conversation history) ----

async function saveMessage(userId, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ user_id: userId, role, content: encrypt(content) });

  if (error) {
    logger.error('database', 'Failed to save message', error);
  }
}

async function getRecentMessages(userId, limit = 10) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('database', 'Failed to get messages', error);
    return [];
  }
  return (data || []).reverse().map((m) => ({ ...m, content: decrypt(m.content) }));
}

// ---- Stats ----

async function getStats() {
  const { count: totalUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });

  const { count: activeUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const { count: pendingUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count: messagesToday } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString());

  return {
    totalUsers: totalUsers || 0,
    activeUsers: activeUsers || 0,
    pendingUsers: pendingUsers || 0,
    messagesToday: messagesToday || 0,
  };
}

// ---- Connect Tokens (for calendar OAuth flow) ----

async function saveConnectToken(token, userId) {
  // Clean up expired tokens first
  await supabase
    .from('connect_tokens')
    .delete()
    .lt('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString());

  const { error } = await supabase
    .from('connect_tokens')
    .insert({ token, user_id: userId });

  if (error) {
    logger.error('database', 'Failed to save connect token', error);
    throw error;
  }
}

async function getConnectToken(token) {
  const { data, error } = await supabase
    .from('connect_tokens')
    .select('*')
    .eq('token', token)
    .single();

  if (error && error.code !== 'PGRST116') {
    logger.error('database', 'Failed to get connect token', error);
  }
  return data;
}

async function deleteConnectToken(token) {
  await supabase
    .from('connect_tokens')
    .delete()
    .eq('token', token);
}

// ---- Calendar Connections ----

async function saveCalendarConnection(userId, provider, credentials, calendarId) {
  // Upsert: if connection exists for this user+provider, update it
  const existing = await getCalendarConnection(userId, provider);
  if (existing) {
    const { error } = await supabase
      .from('calendar_connections')
      .update({ credentials: encrypt(credentials), calendar_id: calendarId, sync_token: null, last_synced_at: null })
      .eq('id', existing.id);
    if (error) {
      logger.error('database', 'Failed to update calendar connection', error);
      throw error;
    }
    logger.info('database', 'Calendar connection updated', { userId, provider });
    return existing;
  }

  const { data, error } = await supabase
    .from('calendar_connections')
    .insert({ user_id: userId, provider, credentials: encrypt(credentials), calendar_id: calendarId })
    .select()
    .single();

  if (error) {
    logger.error('database', 'Failed to save calendar connection', error);
    throw error;
  }
  logger.info('database', 'Calendar connection saved', { userId, provider });
  return data;
}

async function getCalendarConnection(userId, provider) {
  const { data, error } = await supabase
    .from('calendar_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .single();

  if (error && error.code !== 'PGRST116') {
    logger.error('database', 'Failed to get calendar connection', error);
  }
  if (data) data.credentials = decrypt(data.credentials);
  return data;
}

async function getUserCalendarConnections(userId) {
  const { data, error } = await supabase
    .from('calendar_connections')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    logger.error('database', 'Failed to get user calendar connections', error);
    return [];
  }
  return (data || []).map((c) => ({ ...c, credentials: decrypt(c.credentials) }));
}

async function getAllCalendarConnections() {
  const { data, error } = await supabase
    .from('calendar_connections')
    .select('*');

  if (error) {
    logger.error('database', 'Failed to get all calendar connections', error);
    return [];
  }
  return (data || []).map((c) => ({ ...c, credentials: decrypt(c.credentials) }));
}

async function updateCalendarCredentials(connectionId, credentials) {
  const { error } = await supabase
    .from('calendar_connections')
    .update({ credentials: encrypt(credentials) })
    .eq('id', connectionId);

  if (error) logger.error('database', 'Failed to update calendar credentials', error);
}

async function updateCalendarSyncToken(connectionId, syncToken) {
  const { error } = await supabase
    .from('calendar_connections')
    .update({ sync_token: syncToken, last_synced_at: new Date().toISOString() })
    .eq('id', connectionId);

  if (error) logger.error('database', 'Failed to update sync token', error);
}

async function deleteCalendarConnection(userId, provider) {
  const { error } = await supabase
    .from('calendar_connections')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);

  if (error) {
    logger.error('database', 'Failed to delete calendar connection', error);
    throw error;
  }
  logger.info('database', 'Calendar connection deleted', { userId, provider });
}

// ---- Events with External ID support ----

async function getEventByExternalId(userId, externalId) {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .eq('external_id', externalId)
    .single();

  if (error && error.code !== 'PGRST116') {
    logger.error('database', 'Failed to get event by external ID', error);
  }
  return data;
}

async function getEventById(eventId) {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', eventId)
    .single();

  if (error && error.code !== 'PGRST116') {
    logger.error('database', 'Failed to get event by ID', error);
  }
  return data;
}

async function addEventFromExternal(userId, event) {
  const { data, error } = await supabase
    .from('events')
    .insert({
      user_id: userId,
      title: event.title,
      datetime: event.datetime,
      location: event.location,
      external_id: event.external_id,
      source: event.source,
    })
    .select()
    .single();

  if (error) {
    logger.error('database', 'Failed to add event from external', error);
    throw error;
  }
  return data;
}

async function updateEventFromExternal(eventId, updates) {
  const { error } = await supabase
    .from('events')
    .update({
      title: updates.title,
      datetime: updates.datetime,
      location: updates.location,
    })
    .eq('id', eventId);

  if (error) logger.error('database', 'Failed to update event from external', error);
}

async function deleteEventByExternalId(userId, externalId) {
  const { error } = await supabase
    .from('events')
    .delete()
    .eq('user_id', userId)
    .eq('external_id', externalId);

  if (error) logger.error('database', 'Failed to delete event by external ID', error);
}

async function getUnpushedEvents(userId) {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .is('external_id', null)
    .is('source', null)
    .gte('datetime', new Date().toISOString())
    .order('datetime', { ascending: true });

  if (error) {
    logger.error('database', 'Failed to get unpushed events', error);
    return [];
  }
  return data || [];
}

// ---- Tasks/Shopping with External ID (Apple Reminders) ----

async function getTaskByExternalId(userId, externalId) {
  const { data } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('external_id', externalId)
    .single();
  return data;
}

async function getTaskById(taskId) {
  const { data } = await supabase.from('tasks').select('*').eq('id', taskId).single();
  return data;
}

async function addTaskFromExternal(userId, content, externalId) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({ user_id: userId, category: 'כללי', content, external_id: externalId, source: 'apple' })
    .select()
    .single();
  if (error) logger.error('database', 'Failed to add task from external', error);
  return data;
}

async function getUnpushedTasks(userId) {
  const { data } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('completed', false)
    .is('external_id', null)
    .order('created_at', { ascending: true });
  return data || [];
}

async function markTaskPushed(taskId, externalId) {
  await supabase.from('tasks').update({ external_id: externalId, source: 'apple' }).eq('id', taskId);
}

async function getShoppingItemById(itemId) {
  const { data } = await supabase.from('shopping_list').select('*').eq('id', itemId).single();
  return data;
}

async function getUnpushedShoppingItems(userId) {
  const { data } = await supabase
    .from('shopping_list')
    .select('*')
    .eq('user_id', userId)
    .eq('done', false)
    .is('external_id', null)
    .order('created_at', { ascending: true });
  return data || [];
}

async function markShoppingPushed(itemId, externalId) {
  await supabase.from('shopping_list').update({ external_id: externalId, source: 'apple' }).eq('id', itemId);
}

async function markEventPushed(eventId, externalId, source) {
  const { error } = await supabase
    .from('events')
    .update({ external_id: externalId, source })
    .eq('id', eventId);

  if (error) logger.error('database', 'Failed to mark event pushed', error);
}

module.exports = {
  supabase,
  getUser,
  createUser,
  activateUser,
  blockUser,
  deleteUser,
  updateUserPhone,
  getPendingUsers,
  getAllUsers,
  addEvent,
  getUpcomingEvents,
  getUpcomingEventsByDateRange,
  getEventsMatchingContent,
  deleteEventByContent,
  deleteAllEvents,
  deleteTaskByContent,
  getEventsForReminder,
  getTodayEventsAllUsers,
  getTomorrowEventsAllUsers,
  getEventsForHourlyReminder,
  markReminderSent,
  addTask,
  getTasks,
  getCategories,
  getCategoriesWithCounts,
  deleteTasksByCategory,
  completeTask,
  completeTaskByContent,
  addShoppingItem,
  getShoppingList,
  markShoppingDone,
  markShoppingDoneById,
  clearShoppingList,
  addReminder,
  getDueReminders,
  markReminderDone,
  addRecurringEvent,
  getActiveRecurringEvents,
  getUserRecurringEvents,
  deleteRecurringEventByContent,
  recurringEventExistsToday,
  savePollMapping,
  getPollMapping,
  saveMessage,
  getRecentMessages,
  getStats,
  saveConnectToken,
  getConnectToken,
  deleteConnectToken,
  saveCalendarConnection,
  getCalendarConnection,
  getUserCalendarConnections,
  getAllCalendarConnections,
  updateCalendarCredentials,
  updateCalendarSyncToken,
  deleteCalendarConnection,
  getEventByExternalId,
  getEventById,
  addEventFromExternal,
  updateEventFromExternal,
  deleteEventByExternalId,
  getUnpushedEvents,
  markEventPushed,
  getTaskByExternalId,
  getTaskById,
  addTaskFromExternal,
  getUnpushedTasks,
  markTaskPushed,
  getShoppingItemById,
  getUnpushedShoppingItems,
  markShoppingPushed,
  getStartOfToday,
  getUserTimezone,
};
