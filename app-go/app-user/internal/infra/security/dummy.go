package security

import "golang.org/x/crypto/bcrypt"

// dummyHash is a valid bcrypt hash (cost 10) of a random throwaway value. Login
// compares against it when the account does not exist / has no password so the
// response time does not reveal which factor failed (account enumeration).
const dummyHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"

// DummyVerify burns roughly one bcrypt comparison without touching a real hash.
func DummyVerify(password string) {
	_ = bcrypt.CompareHashAndPassword([]byte(dummyHash), []byte(password))
}
