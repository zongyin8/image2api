FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PROVISION_DATA_DIR=/data

WORKDIR /app
COPY provisioner/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY provisioner /app/provisioner

EXPOSE 18002
CMD ["uvicorn", "provisioner.app:app", "--host", "127.0.0.1", "--port", "18002", "--no-access-log"]
