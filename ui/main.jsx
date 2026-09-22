// React 浏览器入口：挂载唯一根组件，并加载全局样式。
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './style.css';

createRoot(document.getElementById('app-root')).render(<App />);
