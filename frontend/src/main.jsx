import ReactDOM from 'react-dom/client';
import { LiveGraphVisualization } from './LiveGraphVisualization.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
    <LiveGraphVisualization />
  </div>
);
