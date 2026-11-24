FROM node:20-bookworm-slim

# Install arduino-cli into /usr/local/bin and clean up apt cache
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=/usr/local/bin sh \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Switch to non-root user before installing AVR core so ~/.arduino15 permissions match at runtime
USER node
WORKDIR /app

RUN arduino-cli core update-index && arduino-cli core install arduino:avr

COPY --chown=node:node package.json ./
RUN npm install --omit=dev

COPY --chown=node:node server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
