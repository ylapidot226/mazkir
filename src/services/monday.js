const config = require('../config');
const logger = require('../utils/logger');

const API_URL = 'https://api.monday.com/v2';

/**
 * Build the OAuth authorization URL
 */
function getAuthUrl(state) {
  const redirectUri = config.monday.redirectUri || `${config.baseUrl}/monday/callback`;
  const params = new URLSearchParams({
    client_id: config.monday.clientId,
    redirect_uri: redirectUri,
    state,
  });
  logger.info('monday', 'OAuth URL generated', { clientId: config.monday.clientId ? 'set' : 'MISSING', redirectUri });
  return `https://auth.monday.com/oauth2/authorize?${params}`;
}

/**
 * Exchange authorization code for access token
 */
async function getTokenFromCode(code) {
  const res = await fetch('https://auth.monday.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.monday.clientId,
      client_secret: config.monday.clientSecret,
      code,
      redirect_uri: config.monday.redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Monday OAuth token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

/**
 * Execute a GraphQL query/mutation against Monday.com API
 */
async function graphql(accessToken, query, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': accessToken,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Monday API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (data.errors && data.errors.length > 0) {
    throw new Error(`Monday GraphQL error: ${data.errors[0].message}`);
  }
  return data.data;
}

/**
 * Get current user info (verify token works)
 */
async function getMe(accessToken) {
  const data = await graphql(accessToken, `query { me { id name email } }`);
  return data.me;
}

/**
 * Get all boards the user has access to
 */
async function getBoards(accessToken) {
  const data = await graphql(accessToken, `
    query {
      boards(limit: 50, order_by: used_at) {
        id
        name
        description
        state
        board_kind
      }
    }
  `);
  return (data.boards || []).filter(b => b.state === 'active');
}

/**
 * Get board details with groups and column definitions
 */
async function getBoardDetails(accessToken, boardId) {
  const data = await graphql(accessToken, `
    query($boardId: [ID!]!) {
      boards(ids: $boardId) {
        id
        name
        groups {
          id
          title
        }
        columns {
          id
          title
          type
          settings_str
        }
      }
    }
  `, { boardId: [boardId] });
  return data.boards?.[0] || null;
}

/**
 * Get items from a board (with pagination)
 */
async function getBoardItems(accessToken, boardId, limit = 20) {
  const data = await graphql(accessToken, `
    query($boardId: [ID!]!, $limit: Int!) {
      boards(ids: $boardId) {
        items_page(limit: $limit) {
          items {
            id
            name
            group { id title }
            column_values {
              id
              title
              text
              type
            }
          }
        }
      }
    }
  `, { boardId: [boardId], limit });
  return data.boards?.[0]?.items_page?.items || [];
}

/**
 * Create a new item on a board
 */
async function createItem(accessToken, boardId, itemName, groupId = null) {
  if (groupId) {
    const data = await graphql(accessToken, `
      mutation($boardId: ID!, $itemName: String!, $groupId: String!) {
        create_item(board_id: $boardId, item_name: $itemName, group_id: $groupId) {
          id
          name
        }
      }
    `, { boardId, itemName, groupId });
    return data.create_item;
  }

  const data = await graphql(accessToken, `
    mutation($boardId: ID!, $itemName: String!) {
      create_item(board_id: $boardId, item_name: $itemName) {
        id
        name
      }
    }
  `, { boardId, itemName });
  return data.create_item;
}

/**
 * Update a column value on an item
 */
async function updateColumnValue(accessToken, boardId, itemId, columnId, value) {
  const data = await graphql(accessToken, `
    mutation($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
      change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
        id
        name
      }
    }
  `, { boardId, itemId, columnId, value });
  return data.change_simple_column_value;
}

/**
 * Add an update (comment) to an item
 */
async function addUpdate(accessToken, itemId, body) {
  const data = await graphql(accessToken, `
    mutation($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
  `, { itemId, body });
  return data.create_update;
}

/**
 * Move an item to a different group
 */
async function moveItemToGroup(accessToken, itemId, groupId) {
  const data = await graphql(accessToken, `
    mutation($itemId: ID!, $groupId: String!) {
      move_item_to_group(item_id: $itemId, group_id: $groupId) {
        id
        name
      }
    }
  `, { itemId, groupId });
  return data.move_item_to_group;
}

/**
 * Delete an item
 */
async function deleteItem(accessToken, itemId) {
  const data = await graphql(accessToken, `
    mutation($itemId: ID!) {
      delete_item(item_id: $itemId) {
        id
      }
    }
  `, { itemId });
  return data.delete_item;
}

/**
 * Search items across boards by name
 */
async function searchItems(accessToken, searchText, boardId = null) {
  let query;
  if (boardId) {
    query = `
      query($boardId: [ID!]!, $searchText: String!) {
        boards(ids: $boardId) {
          items_page(limit: 10, query_params: { rules: [{column_id: "name", compare_value: [$searchText], operator: contains_text}] }) {
            items {
              id
              name
              group { title }
              column_values {
                id
                title
                text
                type
              }
            }
          }
        }
      }
    `;
    const data = await graphql(accessToken, query, { boardId: [boardId], searchText });
    return data.boards?.[0]?.items_page?.items || [];
  } else {
    // Search across all boards - get recent boards and search each
    const boards = await getBoards(accessToken);
    const results = [];
    for (const board of boards.slice(0, 5)) {
      try {
        const items = await searchItems(accessToken, searchText, board.id);
        for (const item of items) {
          results.push({ ...item, board_name: board.name, board_id: board.id });
        }
      } catch (e) {
        // Skip boards with errors
      }
      if (results.length >= 10) break;
    }
    return results.slice(0, 10);
  }
}

/**
 * Get available status labels for a status column
 */
async function getStatusLabels(accessToken, boardId, columnId) {
  const board = await getBoardDetails(accessToken, boardId);
  if (!board) return {};
  const col = board.columns.find(c => c.id === columnId);
  if (!col || col.type !== 'status') return {};
  try {
    const settings = JSON.parse(col.settings_str);
    return settings.labels || {};
  } catch {
    return {};
  }
}

module.exports = {
  getAuthUrl,
  getTokenFromCode,
  getMe,
  getBoards,
  getBoardDetails,
  getBoardItems,
  createItem,
  updateColumnValue,
  addUpdate,
  moveItemToGroup,
  deleteItem,
  searchItems,
  getStatusLabels,
};
