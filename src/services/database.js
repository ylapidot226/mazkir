const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

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

async function getUpcomingEvents(userId) {
  // Include events from start of today (Israel time), not just from "now"
  // This ensures events later today are included even if added moments ago
  const startOfTodayISO = getStartOfTodayIsrael().toISOString();

  logger.info('database', 'Querying upcoming events', { userId, since: startOfTodayISO });

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .gte('datetime', startOfTodayISO)
    .order('datetime', { ascending: true });

  if (error) {
    logger.error('database', 'Failed to get events', error);
    throw error;
  }
  return data || [];
}

/**
 * Get start of today in Israel timezone as a UTC Date object
 */
function getStartOfTodayIsrael() {
  // Get Israel offset by comparing UTC and Israel formatted times
  const now = new Date();
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
  const ilStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour12: false });
  const offsetMs = new Date(ilStr) - new Date(utcStr);

  // Shift now by Israel offset to get Israel local time, then zero out hours
  const israelNow = new Date(now.getTime() + offsetMs);
  israelNow.setUTCHours(0, 0, 0, 0);

  // Shift back to UTC
  return new Date(israelNow.getTime() - offsetMs);
}

async function deleteEventByContent(userId, content) {
  const { data } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .ilike('title', `%${content}%`);

  if (data && data.length > 0) {
    for (const event of data) {
      await supabase.from('events').delete().eq('id', event.id);
    }
    logger.info('database', 'Events deleted', { userId, count: data.length });
    return data.length;
  }
  return 0;
}

async function deleteAllEvents(userId) {
  const { data } = await supabase
    .from('events')
    .select('id')
    .eq('user_id', userId)
    .gte('datetime', getStartOfTodayIsrael().toISOString());

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
  const startOfToday = getStartOfTodayIsrael();
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
 * Get events happening in ~1 hour that haven't been reminded yet
 */
async function getEventsForHourlyReminder() {
  const now = new Date();
  const in55min = new Date(now.getTime() + 55 * 60 * 1000);
  const in65min = new Date(now.getTime() + 65 * 60 * 1000);

  const { data, error } = await supabase
    .from('events')
    .select('*, users(phone_number)')
    .eq('reminder_sent', false)
    .gte('datetime', in55min.toISOString())
    .lte('datetime', in65min.toISOString());

  if (error) {
    logger.error('database', 'Failed to get hourly reminders', error);
    return [];
  }

  return data || [];
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
    .select('*, users(phone_number)')
    .eq('sent', false)
    .lte('remind_at', in1min.toISOString());

  if (error) {
    logger.error('database', 'Failed to get due reminders', error);
    return [];
  }
  return data || [];
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
  const startOfToday = getStartOfTodayIsrael();
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

// ---- Poll Mappings (in-memory, polls expire after 24h) ----

const pollMappings = new Map();

function savePollMapping(userId, pollMessageId, tasks) {
  const key = `${userId}:${pollMessageId}`;
  pollMappings.set(key, {
    tasks: tasks.map((t) => ({ id: t.id, content: t.content })),
    createdAt: Date.now(),
  });
  // Clean up old mappings (older than 24h)
  for (const [k, v] of pollMappings) {
    if (Date.now() - v.createdAt > 24 * 60 * 60 * 1000) {
      pollMappings.delete(k);
    }
  }
}

function getPollMapping(userId, pollMessageId) {
  const key = `${userId}:${pollMessageId}`;
  return pollMappings.get(key) || null;
}

// ---- Messages (conversation history) ----

async function saveMessage(userId, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ user_id: userId, role, content });

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
  return (data || []).reverse();
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

module.exports = {
  supabase,
  getUser,
  createUser,
  activateUser,
  blockUser,
  deleteUser,
  getPendingUsers,
  getAllUsers,
  addEvent,
  getUpcomingEvents,
  deleteEventByContent,
  deleteAllEvents,
  deleteTaskByContent,
  getEventsForReminder,
  getTodayEventsAllUsers,
  getEventsForHourlyReminder,
  markReminderSent,
  addTask,
  getTasks,
  getCategories,
  completeTask,
  completeTaskByContent,
  addShoppingItem,
  getShoppingList,
  markShoppingDone,
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
};
