FROM python:3.12-slim
WORKDIR /app
COPY . /app
RUN pip install --upgrade pip
RUN pip install -r requirements.txt --root-user-action=ignore
EXPOSE 8080
CMD ["python", "bot.py"]
