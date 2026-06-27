/**
 * utils.js
 * Shared helpers for response formatting and CORS.
 *
 * BUG FIXED #2: File was named util.js but index.js imported from './utils.js'
 * — renamed this file to utils.js to match the import.
 */

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message, status }, status);
}