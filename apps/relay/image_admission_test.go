package relay

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestImageAdmissionKeepsTransferConcurrencyBounded(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &Server{ctx: ctx}
	var wg sync.WaitGroup
	var mu sync.Mutex
	active, maxActive := 0, 0
	perDevice := map[string]int{}
	for device := range 4 {
		for range 20 {
			wg.Go(func() {
				id := fmt.Sprint(device)
				release := s.admitImage(ctx, id)
				defer release()
				mu.Lock()
				active++
				perDevice[id]++
				if active > maxActive {
					maxActive = active
				}
				if active > 12 || perDevice[id] > 4 {
					t.Errorf("image transfer limit exceeded: total=%d device=%d", active, perDevice[id])
				}
				mu.Unlock()
				time.Sleep(2 * time.Millisecond)
				mu.Lock()
				active--
				perDevice[id]--
				mu.Unlock()
			})
		}
	}
	wg.Wait()
	if maxActive < 4 || s.imageQueueRefs != 0 || len(s.imageQueue) != 0 || len(s.imageSlots) != 0 {
		t.Fatal("image admission did not use or release its slots", maxActive, s.imageQueueRefs)
	}
}

func waitImageAdmissions(t *testing.T, s *Server, count int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		refs := s.imageQueueRefs
		s.mu.Unlock()
		if refs == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("image request never reached admission queue")
}

func TestImageAdmissionCancellationReleasesPartialPermits(t *testing.T) {
	for _, global := range []bool{false, true} {
		t.Run(fmt.Sprint(global), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s := &Server{ctx: ctx}
			count := 4
			if global {
				count = 12
			}
			for index := range count {
				release := s.admitImage(ctx, fmt.Sprint(index/4))
				defer release()
			}
			request, abort := context.WithCancel(context.Background())
			device := "0"
			if global {
				device = "another-device"
			}
			done := make(chan struct{})
			go func() {
				defer close(done)
				expectFault(t, "image-cancelled", func() { s.admitImage(request, device)() })
			}()
			waitImageAdmissions(t, s, count+1)
			abort()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("cancelled image remained queued")
			}
			waitImageAdmissions(t, s, count)
			if global {
				s.mu.Lock()
				_, retained := s.imageQueue[device]
				s.mu.Unlock()
				if retained {
					t.Fatal("partially acquired device slot retained")
				}
			}
		})
	}
}

func TestImageAdmissionBoundsWaitingAndStopsOnShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &Server{ctx: ctx}
	for range 4 {
		release := s.admitImage(ctx, "pc")
		defer release()
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			expectFault(t, "relay-closing", func() { s.admitImage(context.Background(), "pc")() })
		})
	}
	waitImageAdmissions(t, s, 24)
	expectFault(t, "images-busy", func() { s.admitImage(context.Background(), "pc")() })
	cancel()
	wg.Wait()
	waitImageAdmissions(t, s, 4)
}
