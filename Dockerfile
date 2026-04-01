# Specify the base image
FROM apify/actor-node:20

# Copy all files
COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/

# Install dependencies (including dev)
RUN npm install --include=dev

# Compile TypeScript
RUN npm run build

# Start the Actor
CMD npm run start
