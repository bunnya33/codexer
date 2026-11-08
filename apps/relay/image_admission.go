package relay

import (
	"context"
	"sync"
	"time"
)

type imageAdmission struct {
	slots chan struct{}
	refs  int
}

// A twenty-picture message must wait for the existing four transfer slots,
// without increasing the number of full image responses buffered by an Agent.
func (s *Server) admitImage(ctx context.Context, device string) func() {
	s.mu.Lock()
	if s.imageQueue == nil {
		s.imageQueue = map[string]*imageAdmission{}
		s.imageSlots = make(chan struct{}, 12)
	}
	entry := s.imageQueue[device]
	if s.imageQueueRefs >= 96 || entry != nil && entry.refs >= 24 {
		s.mu.Unlock()
		fail(429, "images-busy")
	}
	if entry == nil {
		entry = &imageAdmission{slots: make(chan struct{}, 4)}
		s.imageQueue[device] = entry
	}
	entry.refs++
	s.imageQueueRefs++
	global := s.imageSlots
	s.mu.Unlock()

	var once sync.Once
	deviceSlot, globalSlot, admitted := false, false, false
	release := func() {
		once.Do(func() {
			if globalSlot {
				<-global
			}
			if deviceSlot {
				<-entry.slots
			}
			s.mu.Lock()
			entry.refs--
			s.imageQueueRefs--
			if entry.refs == 0 {
				delete(s.imageQueue, device)
			}
			s.mu.Unlock()
		})
	}
	defer func() {
		if !admitted {
			release()
		}
	}()
	wait, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	acquire := func(slots chan struct{}) {
		select {
		case slots <- struct{}{}:
		case <-wait.Done():
			if ctx.Err() != nil {
				fail(499, "image-cancelled")
			}
			fail(504, "image-timeout")
		case <-s.ctx.Done():
			fail(503, "relay-closing")
		}
	}
	acquire(entry.slots)
	deviceSlot = true
	acquire(global)
	globalSlot, admitted = true, true
	return release
}
