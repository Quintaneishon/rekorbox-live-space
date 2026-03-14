# rekordbox-live

Visualización en tiempo real de la canción que está sonando en Rekordbox sobre un grafo 3D.

Cuando un DJ carga una pista, el nodo correspondiente en el grafo se ilumina, parpadea y la cámara vuela automáticamente hacia él. Los nodos están coloreados por género y conectados mediante enlaces de similitud (KNN) calculados por un backend de Python independiente.

---

## Arquitectura

```
┌─────────────────────┐      embeddings/graph/tags      ┌──────────────────────┐
│  Python backend     │ ◄────────────────────────────── │  Node.js server      │
│  (puerto 5000)      │                                  │  (puerto 3001)       │
└─────────────────────┘                                  │  HTTP + WebSocket    │
                                                         └──────────┬───────────┘
                                ┌────────────────────────────────── │ ──────────┐
                                │  Pro DJ Link (red local)          │           │
                                │  Pioneer CDJ / XDJ                ▼           │
                                └─────────────────────────► WS broadcast        │
                                                                     │
                                                         ┌───────────▼──────────┐
                                                         │  Frontend React      │
                                                         │  (puerto 5174)       │
                                                         │  react-force-graph-3d│
                                                         └──────────────────────┘
```

- **Python backend** — repositorio separado. Expone los endpoints `/embeddings`, `/graph` y `/tags`.
- **Node.js server** — puente entre el hardware Pioneer (Pro DJ Link) y los clientes WebSocket. Carga los embeddings al arrancar y hace proxy de `/graph` y `/tags`.
- **Frontend React** — grafo 3D interactivo. Se conecta al servidor Node.js por HTTP y WebSocket.

---

## Requisitos

- Node.js ≥ 18
- El backend de Python corriendo (ver su propio repositorio)
- Para el modo Pro DJ Link: hardware Pioneer DJ (CDJ/XDJ) en la **misma red local** que el servidor

---

## Instalación

```bash
# Clonar el repositorio
git clone <url-del-repo>
cd rekordbox-live

# Instalar dependencias del servidor
npm install

# Instalar dependencias del frontend
cd frontend
npm install
cd ..
```

---

## Configuración

### Servidor Node.js

Copia `.env` y ajusta los valores:

```bash
cp .env .env.local   # o edita .env directamente
```

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `PORT` | `3001` | Puerto del servidor HTTP + WebSocket |
| `PYTHON_BACKEND_URL` | `http://127.0.0.1:5000` | URL del backend de Python |
| `MODEL` | `whisper_contrastive` | Modelo de embeddings |
| `DATASET` | `base` | Dataset a usar |

### Frontend

```bash
cp frontend/.env.example frontend/.env
```

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `VITE_SERVER_URL` | `http://localhost:3001` | URL HTTP del servidor Node.js |
| `VITE_WS_URL` | `ws://localhost:3001` | URL WebSocket del servidor Node.js |

Modifica estas variables si el servidor Node.js corre en una máquina diferente a la del navegador.

---

## Ejecución

### Modo completo — Pro DJ Link (hardware Pioneer en red local)

Requiere que los CDJ/XDJ estén encendidos y en la misma red que el servidor.

**Terminal 1 — backend de Python** (ver su repositorio):
```bash
# Desde el directorio del backend de Python
python app.py
```

**Terminal 2 — servidor Node.js:**
```bash
npm start
# o en modo desarrollo con recarga automática:
npm run dev
```

**Terminal 3 — frontend:**
```bash
cd frontend
npm run dev
```

Abre el navegador en `http://localhost:5174`. En cuanto Rekordbox cargue una pista en un CDJ, el grafo reaccionará en tiempo real.

---

### Modo manual — sin hardware Pioneer

Si no dispones de hardware Pioneer o Rekordbox está en la misma máquina que el servidor (lo que puede generar conflicto de puertos), puedes controlar la visualización mediante la API HTTP.

**Arrancar igual** que el modo completo. El servidor detecta automáticamente que Pro DJ Link no está disponible y continúa en modo HTTP.

**Cambiar la pista activa:**
```bash
curl -X POST http://localhost:3001/track \
  -H "Content-Type: application/json" \
  -d '{"title": "nombre de la pista", "playing": true}'
```

**Cambiar el estado de reproducción (pausa/reanudar):**
```bash
curl -X POST http://localhost:3001/play \
  -H "Content-Type: application/json" \
  -d '{"playing": false}'
```

---

## API del servidor Node.js

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servidor |
| `GET` | `/points` | Array de puntos de embeddings cargados |
| `GET` | `/graph` | Proxy → Python `/graph` (nodos + enlaces KNN) |
| `GET` | `/tags` | Proxy → Python `/tags` (géneros) |
| `POST` | `/track` | Dispara manualmente un evento `track_change` |
| `POST` | `/play` | Dispara manualmente un evento `play_state` |

### Mensajes WebSocket

| Tipo | Campos | Descripción |
|---|---|---|
| `init` | `points` | Enviado al conectar; contiene todos los puntos de embeddings |
| `track_change` | `title`, `idx`, `point`, `playing`, `playerNum`, `score` | Nueva pista cargada o en aire |
| `play_state` | `playing`, `title`, `idx`, `point`, `playerNum` | Pausa o reanudación sin cambio de pista |
| `error` | `message` | Error interno del servidor |

---

## Limitaciones conocidas

- **Red local obligatoria para Pro DJ Link** — el protocolo Pro DJ Link es UDP multicast; el hardware Pioneer y el servidor deben estar en la misma subred. No funciona a través de internet ni de VPNs estándar.
- **Conflicto de puerto 50000 con Rekordbox en la misma máquina** — Rekordbox y el servidor compiten por el puerto UDP 50000. El servidor aplica `reuseAddr` para mitigarlo, pero en algunos sistemas operativos el conflicto persiste. Si ocurre, usa el modo manual.
- **Matching de títulos por similitud textual** — el servidor relaciona el nombre de la pista de Rekordbox con los nodos del grafo mediante Jaccard de palabras. Si el nombre en Rekordbox difiere mucho del nombre del archivo (acentos, featuring, edits), el nodo puede no encontrarse.
- **Los embeddings se cargan una sola vez al arrancar** — si el backend de Python actualiza su dataset, hay que reiniciar el servidor Node.js para reflejar los cambios.
- **Sin persistencia de estado** — al reiniciar el servidor se pierde el estado de reproducción; el frontend vuelve a conectarse automáticamente pero muestra el grafo vacío hasta el siguiente evento de pista.
- **Node.js ≥ 18 requerido** — se usa `fetch` nativo y ESModules (`"type": "module"`).
