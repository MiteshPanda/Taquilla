import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createServices } from './services.js';
import './index.css';

const services = createServices(import.meta.env);

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');

createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
