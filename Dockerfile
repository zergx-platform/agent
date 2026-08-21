# syntax=docker/dockerfile:1
FROM recoder-dev002.develop.10.199.64.20.nip.io/node:22-alpine3.24 AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY:-http://mihomo.develop.svc.cluster.local:7890} \
    HTTPS_PROXY=${HTTPS_PROXY:-http://mihomo.develop.svc.cluster.local:7890} \
    NO_PROXY=localhost,127.0.0.1,.svc.cluster.local,.svc,.nip.io
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages packages
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts \
    && npm rebuild esbuild \
    && npm run build

FROM recoder-dev002.develop.10.199.64.20.nip.io/node:22-alpine3.24
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules node_modules
COPY --from=build /build/packages packages
ENV NODE_ENV=production \
    RUCODER_PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "packages/server/dist/index.js"]
