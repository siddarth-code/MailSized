# Simple local runner. Render should still start with:
#   uvicorn app.main:app --host 0.0.0.0 --port 8000
from app.main import app

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
