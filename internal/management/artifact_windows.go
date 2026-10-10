package management

import (
	"errors"
	"os"
)

// Privileged updates run on Linux; this keeps client development tests portable.
func openRegularNoFollow(path string) (*os.File, error) {
	info, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("invalid-server-bundle")
	}
	return os.Open(path)
}
