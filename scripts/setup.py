import os
import secrets
from pathlib import Path

root = Path(__file__).resolve().parent.parent
path = root / ".env"
if path.exists():
    print(".env already exists; credentials preserved.")
else:
    content = f"AUTOJB_ADMIN_TOKEN={secrets.token_urlsafe(32)}\nPOSTGRES_PASSWORD={secrets.token_urlsafe(24)}\nAUTOJB_PORT=17830\nAUTOJB_FIXTURE_ENABLED=true\nAUTOJB_USE_JEV=false\nTYPESAFE_API_KEY=\nTYPESAFE_MODEL=jev-latest\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(content)
    print("Created private .env. No credentials printed.")
