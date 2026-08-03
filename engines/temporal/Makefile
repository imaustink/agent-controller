.PHONY: build test vet fmt docker

# Local checks. CI runs the same four (see .github/workflows/ci.yml's
# temporal-engine job); images are built by release.yml from this directory as
# their context.

build:
	go build ./...

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

docker:
	docker build -f Dockerfile.worker -t temporal-engine-worker:latest .
	docker build -f Dockerfile.gateway -t temporal-engine-gateway:latest .
	docker build -f Dockerfile.catalog-sync -t temporal-engine-catalog-sync:latest .
