package main

// Reconcile matches the TS keyed list diff in spirit.
// prev/next are keys.
// reuse[i] is the index in prev of next[i], or -1 if the key is new.
// If prev contains duplicate keys, the last one wins (same as a map set).
// removed is prev indices whose keys do not appear in next.
func Reconcile(prev []string, next []string) (reuse []int, removed []int) {
	prevByKey := make(map[string]int, len(prev))
	for i, k := range prev {
		prevByKey[k] = i
	}

	nextKeys := make(map[string]struct{}, len(next))
	reuse = make([]int, len(next))
	for i, k := range next {
		nextKeys[k] = struct{}{}
		if j, ok := prevByKey[k]; ok {
			reuse[i] = j
		} else {
			reuse[i] = -1
		}
	}

	removed = make([]int, 0)
	for i, k := range prev {
		if _, ok := nextKeys[k]; !ok {
			removed = append(removed, i)
		}
	}
	return reuse, removed
}
