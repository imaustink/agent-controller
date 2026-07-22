.PHONY: build test vet docker helm-lint

build:
	go build ./...

test:
	go test ./...

vet:
	go vet ./...

docker:
	docker build -f Dockerfile.worker -t durable-agents-worker:latest .
	docker build -f Dockerfile.gateway -t durable-agents-gateway:latest .

helm-lint:
	helm lint charts/durable-agents
