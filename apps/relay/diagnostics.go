package relay

import (
	"encoding/json"
	"errors"
	"log"
	"regexp"
)

var sqlStatePattern = regexp.MustCompile(`^[0-9A-Z]{5}$`)

// Preserve useful storage diagnostics without logging queries, payloads,
// account identifiers or exception messages.
func storageFailureEvent(v any) M {
	event := M{"type": "relay.diagnostic", "code": "relay-storage-error"}
	if err, ok := v.(error); ok {
		var state interface{ SQLState() string }
		if errors.As(err, &state) && sqlStatePattern.MatchString(state.SQLState()) {
			event["sqlState"] = state.SQLState()
		}
	}
	return event
}

func logStorageFailure(v any) {
	data, _ := json.Marshal(storageFailureEvent(v))
	log.Print(string(data))
}
