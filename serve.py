from livereload import Server

s = Server()
s.watch('style.json')
s.watch('index.html')
s.watch('sw.js')
s.watch('map.js')
s.serve(host="0.0.0.0", port=8081)
