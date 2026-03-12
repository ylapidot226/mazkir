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
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .gte('datetime', new Date().toISOString())
    .order('datetime', { ascending: true });

  if (error) {
    logger.error('database', 'Failed to get events', error);
    throw error;
  }
  return data || [];
}

async function getEventsForReminder() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  // Events happening in ~24 hours that haven't been reminded
  const { data: dayBefore, error: err1 } = await supabase
    .from('events')
    .select('*, users(phone_number)')
    .eq('reminder_sent', false)
    .gte('datetime', in24h.toISOString())
    .lte('datetime', in25h.toISOString());

  if (err1) logger.error('database', 'Failed to get 24h reminders', err1);

  // Events happening in the next 5 minutes (day-of reminder)
  const in5min = new Date(now.getTime() + 5 * 60 * 1000);
  const { data: dayOf, error: err2 } = await supabase
    .from('events')
    .select('*, users(phone_number)')
    .eq('day_reminder_sent', false)
    .gte('datetime', now.toISOString())
    .lte('datetime', in5min.toISOString());

  if (err2) logger.error('database', 'Failed to get day-of reminders', err2);

  return { dayBefore: dayBefore || [], dayOf: dayOf || [] };
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
  getPendingUsers,
  getAllUsers,
  addEvent,
  getUpcomingEvents,
  getEventsForReminder,
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
  saveMessage,
  getRecentMessages,
  getStats,
};
