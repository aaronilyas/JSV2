package main

import "testing"

func TestEscapeXML(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"plain", "plain"},
		{"&", "&amp;"},
		{"<", "&lt;"},
		{">", "&gt;"},
		{`"`, "&quot;"},
		{`'`, `'`},
		{`a&b<c>d"e'f`, `a&amp;b&lt;c&gt;d&quot;e'f`},
	}
	for _, tc := range cases {
		got := EscapeXML(tc.in)
		if got != tc.want {
			t.Errorf("EscapeXML(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
