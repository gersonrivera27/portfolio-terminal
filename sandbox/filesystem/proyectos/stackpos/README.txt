# StackPOS - Production Full-Stack Platform

Estado: En producción

Trabajando en atención al cliente, veía continuamente fallar el sistema 
de pedidos y facturación, así que me propuse diseñar y lanzar una plataforma 
multi-inquilino (multi-tenant) segura desde cero y operarla yo mismo en producción.

Ahora funciona como un servicio en vivo en un VPS (Python/FastAPI, .NET 8, 
PostgreSQL, RabbitMQ, Nginx) con seguridad integrada desde el principio: 
consultas parametrizadas y schema-as-code.

Tecnologías: Python, FastAPI, .NET 8, PostgreSQL, RabbitMQ, Docker, Nginx
