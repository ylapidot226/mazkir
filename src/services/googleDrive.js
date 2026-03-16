const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Create an authenticated OAuth2 client from stored credentials
 */
function getAuthClient(credentials) {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  auth.setCredentials(credentials);
  return auth;
}

/**
 * Search files in Google Drive by name/query
 * @param {object} credentials - OAuth2 tokens
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum number of results
 * @returns {Array} List of files with name, type, id, link
 */
async function searchFiles(credentials, query, maxResults = 10) {
  const auth = getAuthClient(credentials);
  const drive = google.drive({ version: 'v3', auth });

  const response = await drive.files.list({
    q: `name contains '${query.replace(/'/g, "\\'")}'  and trashed = false`,
    fields: 'files(id, name, mimeType, webViewLink, modifiedTime)',
    pageSize: maxResults,
    orderBy: 'relevance',
  });

  return (response.data.files || []).map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    link: file.webViewLink,
    modifiedTime: file.modifiedTime,
  }));
}

/**
 * List recently modified files in Google Drive
 * @param {object} credentials - OAuth2 tokens
 * @param {number} maxResults - Maximum number of results
 * @returns {Array} List of recent files
 */
async function listRecentFiles(credentials, maxResults = 10) {
  const auth = getAuthClient(credentials);
  const drive = google.drive({ version: 'v3', auth });

  const response = await drive.files.list({
    q: 'trashed = false',
    fields: 'files(id, name, mimeType, webViewLink, modifiedTime)',
    pageSize: maxResults,
    orderBy: 'modifiedTime desc',
  });

  return (response.data.files || []).map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    link: file.webViewLink,
    modifiedTime: file.modifiedTime,
  }));
}

/**
 * Get a shareable link for a file
 * @param {object} credentials - OAuth2 tokens
 * @param {string} fileId - Google Drive file ID
 * @returns {object} File info with link
 */
async function getFileLink(credentials, fileId) {
  const auth = getAuthClient(credentials);
  const drive = google.drive({ version: 'v3', auth });

  const response = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, webViewLink',
  });

  return {
    id: response.data.id,
    name: response.data.name,
    mimeType: response.data.mimeType,
    link: response.data.webViewLink,
  };
}

module.exports = {
  searchFiles,
  listRecentFiles,
  getFileLink,
};
