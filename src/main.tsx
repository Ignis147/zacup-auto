/**
 * Точка входа React-приложения «Заказник».
 * Статическое SPA: сервера нет, все данные — в IndexedDB браузера (§26 ТЗ).
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
