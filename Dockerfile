# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build
RUN npm prune --omit=dev && npm cache clean --force

# Stage 2: serve
FROM nginx:alpine
RUN apk add --no-cache curl && \
    rm -rf /var/cache/apk/* /var/log/nginx/* /etc/nginx/conf.d/* && \
    mkdir -p /var/log/nginx
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
