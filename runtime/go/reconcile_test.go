package main

import (
	"reflect"
	"testing"
)

func TestReconcileReorder(t *testing.T) {
	reuse, removed := Reconcile([]string{"a", "b", "c"}, []string{"c", "a", "b"})
	if !reflect.DeepEqual(reuse, []int{2, 0, 1}) {
		t.Fatalf("reuse = %v", reuse)
	}
	if len(removed) != 0 {
		t.Fatalf("removed = %v", removed)
	}
}

func TestReconcileInsert(t *testing.T) {
	reuse, removed := Reconcile([]string{"a", "c"}, []string{"a", "b", "c"})
	if !reflect.DeepEqual(reuse, []int{0, -1, 1}) {
		t.Fatalf("reuse = %v", reuse)
	}
	if len(removed) != 0 {
		t.Fatalf("removed = %v", removed)
	}
}

func TestReconcileRemove(t *testing.T) {
	reuse, removed := Reconcile([]string{"a", "b", "c"}, []string{"a", "c"})
	if !reflect.DeepEqual(reuse, []int{0, 2}) {
		t.Fatalf("reuse = %v", reuse)
	}
	if !reflect.DeepEqual(removed, []int{1}) {
		t.Fatalf("removed = %v", removed)
	}
}

func TestReconcileDuplicatePrevKeysLastWins(t *testing.T) {
	reuse, removed := Reconcile([]string{"a", "b", "a"}, []string{"a", "c"})
	if !reflect.DeepEqual(reuse, []int{2, -1}) {
		t.Fatalf("reuse = %v (want last 'a' at index 2)", reuse)
	}
	if !reflect.DeepEqual(removed, []int{1}) {
		t.Fatalf("removed = %v", removed)
	}
}
