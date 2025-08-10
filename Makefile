.PHONY: dev test fmt lint build

# Run the application locally with hot reload
dev:
	uvicorn app.main:app --reload --port 8000

# Execute the unit and integration test suite
test:
	pytest --cov=app --cov-report=term-missing

# Automatically format the codebase using ruff (fix) and black
fmt:
	ruff check --fix .
	black .

# Run static analysis without making changes
lint:
	ruff check .
	black --check .

# Build the Docker image for deployment
build:
	docker build -t mailsized .