# Use official Python 3.11 slim image for smaller footprint
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Copy requirements file
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY bot.py .
COPY tokens.json .

# Expose port for Flask (Render default is 8080)
EXPOSE 8080

# Environment variable for Flask
ENV FLASK_APP=bot.py
ENV PORT=8080

# Run the application
CMD ["python", "bot.py"]
