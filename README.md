# Find Your Flame

This project has been split into separate frontend and backend folders.

## Structure

- `backend/` - Flask API server
- `frontend/` - Static website UI

## Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Linux/macOS
# or .venv\Scripts\activate  # Windows
pip install -r requirements.txt
python app.py
```

Backend runs on:
- http://localhost:5000

API endpoint:
- POST http://localhost:5000/api/flames

Example request body:
```json
{
  "name1": "Alice",
  "name2": "Bob"
}
```

## Frontend

Open `frontend/index.html` directly in a browser, or serve it with a local static server.

If you want to use a local preview server:

```bash
cd frontend
python -m http.server 8000
```

Then open:
- http://localhost:8000

## Deploying

- Deploy the backend to a Python hosting service such as Render, Railway, or PythonAnywhere.
- Deploy the frontend as a static site on GitHub Pages, Netlify, or Vercel.
- Update the `API_URL` in `frontend/script.js` to the deployed backend URL.
