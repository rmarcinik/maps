FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

COPY serve.py style.json index.html sw.js map.js ./

EXPOSE 8081

CMD ["uv", "run", "--with", "livereload", "serve.py"]
