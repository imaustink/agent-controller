.PHONY: build test vet docker helm-lint ecr-push

# Local build-and-push to the platform's ECR (no CI: this repo is private/
# local, unlike agent-controller which the platform pipeline builds). The
# ECR repos themselves are platform-managed (Crossplane, created by the
# durable-agents Argo app) — merge the platform PR first, then push.
AWS_PROFILE ?= platform
ECR_ACCOUNT ?= 486491621059
ECR_REGION  ?= us-east-1
ECR         := $(ECR_ACCOUNT).dkr.ecr.$(ECR_REGION).amazonaws.com
TAG         ?= $(shell git rev-parse --short=12 HEAD)

ecr-push:
	aws --profile $(AWS_PROFILE) ecr get-login-password --region $(ECR_REGION) | docker login --username AWS --password-stdin $(ECR)
	for app in gateway worker catalog-sync; do \
	  docker build --platform linux/amd64 -f Dockerfile.$$app -t $(ECR)/durable-agents-$$app:$(TAG) . || exit 1; \
	  docker push $(ECR)/durable-agents-$$app:$(TAG) || exit 1; \
	done
	@echo ""
	@echo "pushed tag: $(TAG)  → set gateway/worker/catalogSync image.tag in gitops/durable-agents/values.yaml"

build:
	go build ./...

test:
	go test ./...

vet:
	go vet ./...

docker:
	docker build -f Dockerfile.worker -t durable-agents-worker:latest .
	docker build -f Dockerfile.gateway -t durable-agents-gateway:latest .
	docker build -f Dockerfile.catalog-sync -t durable-agents-catalog-sync:latest .

helm-lint:
	helm lint charts/durable-agents
