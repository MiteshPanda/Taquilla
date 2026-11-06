import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api/client.js';
import { App } from './App.js';
import { parseWebConfig } from './config.js';
import './index.css';

const { apiUrl } = parseWebConfig(import.meta.env);
const api = createApiClient({ baseUrl: apiUrl });

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');

createRoot(root).render(
  <StrictMode>
    <App api={api} apiUrl={apiUrl} />
  </StrictMode>,
);
