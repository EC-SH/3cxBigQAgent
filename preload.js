/**
 * preload.js — Context Bridge
 *
 * This file runs in a special isolated context that sits between the main
 * process and the renderer (browser window). Think of it as a customs officer:
 * it decides exactly which Node.js / Electron capabilities the web page is
 * allowed to access, and exposes them under a single safe API object.
 *
 * The renderer can call window.electronAPI.someMethod() — that's all it sees.
 * It has NO access to Node.js require(), the filesystem, or Electron internals.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Config ─────────────────────────────────────────────────────────────────
  loadConfig:        ()       => ipcRenderer.invoke('config:load'),
  saveConfig:        (config) => ipcRenderer.invoke('config:save', config),

  // ── Authentication ─────────────────────────────────────────────────────────
  pickJsonFile:      ()       => ipcRenderer.invoke('auth:pickJsonFile'),
  browserLogin:      ()       => ipcRenderer.invoke('auth:browserLogin'),
  submitOauthCode:   (code)   => ipcRenderer.invoke('auth:submitOauthCode', code),

  // ── Agent ──────────────────────────────────────────────────────────────────
  testConnection:    ()       => ipcRenderer.invoke('agent:testConnection'),
  query:             (q)      => ipcRenderer.invoke('agent:query', q),

  // ── Utility ────────────────────────────────────────────────────────────────
  openExternal:      (url)    => ipcRenderer.invoke('shell:openExternal', url),
});
