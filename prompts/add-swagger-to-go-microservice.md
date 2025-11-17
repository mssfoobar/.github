# Add Swagger/OpenAPI Documentation to Go Microservice

## Context

I have a Go microservice in a monorepo with the following structure:
- **Backend**: Go + Chi router + PostgreSQL
- **Package management**: npm workspaces (monorepo has `package.json` at root and in `app/`)
- **Build tools**: npm scripts (no Makefiles - needs to work on Windows)

## Requirements

Add comprehensive Swagger/OpenAPI 2.0 documentation to the Go backend following these patterns:

### 1. Dependencies

Add these Go dependencies to `app/go.mod`:
```go
github.com/swaggo/swag v1.16.6
github.com/swaggo/http-swagger/v2 v2.0.2
github.com/swaggo/files/v2 v2.0.0
```

### 2. NPM Scripts Setup

Update `app/package.json` to add these scripts:
```json
{
  "scripts": {
    "build": "npm run swagger:generate && go build -o bin/app-name cmd/main.go",
    "swagger:install": "go install github.com/swaggo/swag/cmd/swag@latest",
    "swagger:generate": "$(go env GOPATH)/bin/swag init -d ./cmd,./internal/handler -o ./docs --parseDependency --parseInternal",
    "swagger:check": "npm run swagger:generate && git diff --exit-code ./docs || (echo 'Swagger docs are out of date. Run: npm run swagger:generate' && exit 1)"
  }
}
```

**Key points:**
- Use `$(go env GOPATH)/bin/swag` for cross-platform compatibility
- Auto-generate swagger docs during build
- Include `swagger:check` for CI/CD validation

### 3. Main Application Annotations

Add these Swagger annotations to `cmd/main.go`:

```go
package main

import (
    _ "your-module-name/docs"  // Import generated docs
    // ... other imports
)

// @title           [Your Service Name] API
// @version         1.0.0
// @description     [Brief description of your API]

// @contact.name   GitHub Repository
// @contact.url    https://github.com/your-org/your-repo

// @license.name  Apache 2.0
// @license.url   http://www.apache.org/licenses/LICENSE-2.0.html

// @host      (configured at runtime - uses same host as Swagger UI)
// @BasePath  /

// @securityDefinitions.apikey  BearerAuth
// @in                          header
// @name                        Authorization
// @description                 Type "Bearer" followed by a space and JWT token.

func main() {
    // ... your main code
}
```

**Notes:**
- Remove terms of service and contact email (they're often placeholders)
- Host is set dynamically at runtime (see step 4)
- Import the `docs` package (will be generated)

### 4. Router Configuration

Update `internal/handler/root.go` (or equivalent router setup file):

```go
package handler

import (
    "net/http"
    "your-module-name/docs"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    httpSwagger "github.com/swaggo/http-swagger/v2"
)

func NewRouter(db db.DbInterface, config *config.Config) http.Handler {
    r := chi.NewRouter()
    r.Use(middleware.Recoverer)

    // Configure Swagger metadata at runtime
    docs.SwaggerInfo.Title = "[Your Service Name] API"
    docs.SwaggerInfo.Description = "[Your service description]"
    docs.SwaggerInfo.Version = "1.0.0"
    docs.SwaggerInfo.Host = "" // Empty = use same host as Swagger UI page (auto-detects host and port)
    docs.SwaggerInfo.BasePath = "/"
    docs.SwaggerInfo.Schemes = []string{"http", "https"}

    // Mount Swagger UI without logging middleware to avoid excessive logs
    r.Get("/swagger-ui/*", httpSwagger.Handler())

    // Apply logging middleware only to API routes
    r.Group(func(r chi.Router) {
        r.Use(yourLoggingMiddleware())

        // ... your API routes here
        r.Route("/", func(r chi.Router) {
            r.Mount("/", registerHealth())
            r.Mount("/resources", registerResourceHandlers(db))
        })
    })

    return r
}
```

**Critical details:**
- Use `r.Get("/swagger-ui/*", httpSwagger.Handler())` - NOT `r.Mount()`
- Set `docs.SwaggerInfo.Host = ""` for automatic host/port detection
- Configure metadata at runtime to override annotations
- **Mount Swagger UI BEFORE or OUTSIDE logging middleware** to avoid logging all static assets (HTML, CSS, JS files) and cluttering logs. Use route groups to apply logging middleware only to API endpoints.

### 5. Handler Annotations

For each handler function, add Swagger annotations following this pattern:

```go
// CreateResource creates a new resource
// @Summary      Create a new resource
// @Description  Creates a new resource with the provided data. Returns the created resource with ID.
// @Tags         Resources
// @Security     BearerAuth
// @Accept       json
// @Produce      json
// @Param        body  body      CreateResourceRequest  true  "Resource data"
// @Success      201   {object}  SuccessResponse{data=ResourceResponse}  "Resource created successfully"
// @Failure      400   {object}  ErrorResponse                            "Bad request - invalid data"
// @Failure      401   {object}  ErrorResponse                            "Unauthorized"
// @Failure      500   {object}  ErrorResponse                            "Internal server error"
// @Router       /resources [post]
func (h *ResourceHandler) CreateResource(w http.ResponseWriter, r *http.Request) {
    // Implementation
}
```

**Annotation guide:**
- `@Summary` - Brief one-line description
- `@Description` - Detailed explanation
- `@Tags` - Group endpoints (e.g., "Admin", "Resources", "Health")
- `@Security BearerAuth` - Require authentication
- `@Param` - Define parameters: `name location type required "description"`
  - Locations: `path`, `query`, `header`, `body`, `formData`
- `@Success` - Success responses with type
- `@Failure` - Error responses
- `@Router` - Route path and HTTP method

### 6. Type Definitions

Create `internal/handler/types.go` for shared Swagger response types:

```go
package handler

// ErrorResponse represents an error response from the API
type ErrorResponse struct {
    Success       bool                   `json:"success" example:"false"`
    Message       string                 `json:"message" example:"Error message"`
    Code          string                 `json:"code" example:"BAD_REQUEST"`
    CorrelationID string                 `json:"correlation_id" example:"123e4567-e89b-12d3-a456-426614174000"`
    Details       map[string]interface{} `json:"details,omitempty"`
} // @name Error

// SuccessResponse represents a successful response from the API
type SuccessResponse struct {
    Success bool        `json:"success" example:"true"`
    Message string      `json:"message" example:"Operation successful"`
    Data    interface{} `json:"data,omitempty"`
} // @name Success

// PaginationResponse represents a paginated response
type PaginationResponse struct {
    Success bool             `json:"success" example:"true"`
    Message string           `json:"message" example:"Retrieved successfully"`
    Page    PaginationInfo   `json:"page"`
    Data    interface{}      `json:"data"`
} // @name PaginatedResponse

// PaginationInfo contains pagination metadata
type PaginationInfo struct {
    TotalRecords int    `json:"total_records" example:"100"`
    Number       int    `json:"number" example:"1"`
    Size         int    `json:"size" example:"10"`
    Count        int    `json:"count" example:"10"`
    Sort         string `json:"sort" example:"created_at:desc"`
} // @name Pagination

// Add your domain-specific types here with proper @name annotations
```

**Type definition rules:**
- Use `// @name YourTypeName` to set Swagger schema name
- Include `json` tags for field names
- Include `example` tags for sample values
- Use `omitempty` for optional fields

### 7. Documentation File

Create `app/docs/SWAGGER.md`:

```markdown
# Swagger/OpenAPI Documentation

## Accessing Swagger UI

Once the service is running, access the Swagger UI at:

```
http://localhost:[PORT]/swagger-ui/index.html
```

Replace `localhost:[PORT]` with your actual service host and port.

## Generating Swagger Documentation

### Prerequisites

Install the swag CLI tool:

```bash
npm run swagger:install
```

### Generate Documentation

From the `app/` directory:

```bash
npm run swagger:generate
```

This generates three files in the `docs/` directory:
- `docs.go` - Go code that registers the swagger spec
- `swagger.json` - OpenAPI 2.0 specification in JSON format
- `swagger.yaml` - OpenAPI 2.0 specification in YAML format

### Build Process Integration

The package.json scripts automatically regenerate Swagger docs during build:

```bash
npm run build      # Generates swagger docs and builds binary
npm start          # Runs service
```

## CI/CD Integration

Add to your CI pipeline to ensure swagger docs are up to date:

```yaml
- name: Check Swagger Documentation
  working-directory: app
  run: |
    npm run swagger:install
    npm run swagger:check
```

## Adding New Endpoints

1. Add Swagger annotations to your handler function
2. Define response types in `internal/handler/types.go` with JSON tags and examples
3. Regenerate documentation: `npm run swagger:generate`
4. Commit the generated files to version control
```

### 8. .gitignore Updates

Ensure `bin/` and `dist/` are in your root `.gitignore`:

```gitignore
# Build artifacts
bin/
dist/
```

### 9. Generate Initial Documentation

Run these commands to generate the initial Swagger files:

```bash
cd app
npm run swagger:install
npm run swagger:generate
```

This creates:
- `app/docs/docs.go`
- `app/docs/swagger.json`
- `app/docs/swagger.yaml`

### 10. Verification Checklist

After implementation, verify:

- [ ] Swagger UI accessible at `http://localhost:[PORT]/swagger-ui/index.html`
- [ ] All endpoints visible in Swagger UI
- [ ] "Try it out" works with Bearer token authentication
- [ ] Base URL auto-detects correct host and port
- [ ] Request/response examples display correctly
- [ ] No 404 errors when accessing Swagger UI
- [ ] `npm run build` succeeds and regenerates docs
- [ ] `npm run swagger:check` passes when docs are up-to-date
- [ ] Contact info shows "GitHub Repository" (no fake email)
- [ ] No "Terms of Service" link

## Common Patterns

### Query Parameters with Defaults

```go
// @Param        page        query     int     false  "Page number"         default(1)
// @Param        size        query     int     false  "Page size"           default(10)
// @Param        status      query     string  false  "Filter by status"    Enums(active, inactive)
```

### Path Parameters

```go
// @Param        id   path      string  true  "Resource ID"  format(uuid)
```

### Optional Filtering

```go
// @Param        filter_tables          query     string  false  "Comma-separated list of tables"  example:"users,orders"
// @Param        filter_min_timestamp   query     string  false  "Minimum timestamp (RFC3339)"     example:"2024-01-01T00:00:00Z"
```

### Nested Response Types

```go
// @Success      200  {object}  SuccessResponse{data=[]ResourceResponse}  "List of resources"
```

## Important Notes

1. **Cross-Platform**: Always use `$(go env GOPATH)/bin/swag` in npm scripts
2. **No Makefile**: Use npm scripts only for Windows compatibility
3. **Dynamic Host**: Set `docs.SwaggerInfo.Host = ""` to auto-detect
4. **Wildcard Route**: Use `r.Get("/swagger-ui/*", httpSwagger.Handler())` not `Mount`
5. **Commit Generated Files**: Include `docs/` in version control
6. **Clean Metadata**: No placeholder emails or fake terms of service links

## Expected File Structure

```
app/
├── cmd/
│   └── main.go                    # Main entry with API info annotations
├── internal/
│   └── handler/
│       ├── root.go                # Router setup with Swagger UI mount
│       ├── types.go               # Shared type definitions for Swagger
│       └── resource.go            # Handler with endpoint annotations
├── docs/                          # Generated Swagger documentation
│   ├── docs.go
│   ├── swagger.json
│   └── swagger.yaml
├── docs/
│   └── SWAGGER.md                 # Documentation guide
├── package.json                   # npm scripts for swagger generation
├── go.mod
└── go.sum
```

---

**Please implement Swagger/OpenAPI documentation following these exact patterns. If you encounter any issues or have questions about the structure, ask before proceeding.**
