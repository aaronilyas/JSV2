package main

import (
	"slices"
	"testing"
)

func TestIDSetInsertionOrder(t *testing.T) {
	var s idSet
	for i := 0; i < 5; i++ {
		s.add(i)
	}
	s.add(2)
	if got := s.snapshot(); !slices.Equal(got, []int{0, 1, 2, 3, 4}) {
		t.Fatalf("add kept duplicate position, got %v", got)
	}
	s.remove(1)
	s.remove(3)
	if got := s.snapshot(); !slices.Equal(got, []int{0, 2, 4}) {
		t.Fatalf("remove, got %v", got)
	}
	s.add(1)
	if got := s.snapshot(); !slices.Equal(got, []int{0, 2, 4, 1}) {
		t.Fatalf("re-add appends, got %v", got)
	}
	s.remove(9)
	if s.len() != 4 {
		t.Fatalf("missing remove changed len to %d", s.len())
	}
	s.clear()
	if s.len() != 0 || s.snapshot() != nil {
		t.Fatalf("clear, len %d snapshot %v", s.len(), s.snapshot())
	}
	s.add(7)
	if got := s.snapshot(); !slices.Equal(got, []int{7}) {
		t.Fatalf("add after clear, got %v", got)
	}
}
