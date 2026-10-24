// Package dto defines the admin-plane JSON response DTOs (wire contract,
// plan/1.0.16 section 5).
//
// It is deliberately a leaf package: no imports from repo/service/router, no
// business logic — only the exact JSON shapes the contract pins. The service
// layer assembles these structs from repo rows, the router serialises them
// verbatim. Keeping them out of package service stops transport shapes from
// leaking into business code and lets both layers share one definition.
package dto
